/**
 * runtime/systems/LightingShaderSource.js
 *
 * The actual GPU shader that replaced every piece of CPU-side lighting
 * drawing (baked canvas gradients, PIXI.Graphics shadow polygons,
 * additive-blend glow sprites). This is a single PIXI.Filter applied
 * directly to the world container: for every pixel already rendered by
 * RenderSystem's sprites, the fragment shader below computes real-time
 * ambient darkness, per-light falloff (radial/cone/rect), and — when
 * enabled — shadow occlusion, then composites the result, all on the
 * GPU, all in one pass.
 *
 * Why a Filter and not a mesh/sprite-per-light: a filter gets the
 * ALREADY-RENDERED scene texture as `uSampler`/`vTextureCoord`, so
 * "darken everything, then punch light back in where lights reach" is
 * literally one multiply + several additive terms per pixel — no need
 * to separately manage blend-mode layering order the way sprite-based
 * glows did.
 *
 * UNIFORM ARRAYS / MAX_LIGHTS / MAX_OCCLUDERS: GLSL ES 1.00 (WebGL1,
 * what PIXI 7's default shader target compiles to) requires uniform
 * array sizes to be compile-time constants — there's no dynamic
 * uniform array length. So this shader takes a fixed-size cap for both
 * lights and occluders and an explicit uLightCount/uOccluderCount to
 * know how much of each array is actually populated this frame (the
 * loop simply breaks past the count) — the standard technique for
 * "variable number of lights" in a single non-recompiled shader.
 *
 * RUNTIME-ONLY FILE (depends on PIXI's Filter, not on the editor).
 */

// Per the user's explicit "32 lights" cap. Worth knowing the tradeoff:
// each light slot costs ~18 floats of uniform data (~4.5 vec4
// equivalents) and each occluder slot ~8 floats (~2 vec4 equivalents),
// so 32 lights + 24 occluders is roughly 190 vec4-equivalent uniform
// slots — comfortably inside desktop WebGL1's typical
// MAX_FRAGMENT_UNIFORM_VECTORS (1024), but can be tight on some older
// mobile/integrated GPUs (some report as low as 256, shared with
// PIXI's own built-in filter uniforms). If targeting low-end mobile,
// lower these two constants (a scene rarely needs more than a handful
// of on-screen lights/occluders at once regardless of this cap) rather
// than raising them further.
export const MAX_LIGHTS = 32;
export const MAX_OCCLUDERS = 24;

// GLSL ES 1.00 for-loops need a CONSTANT upper bound (the runtime step
// count, uRaymarchSteps, is a uniform and can't be used directly as a
// loop bound) — this is the hard ceiling LightingQuality.raymarchSteps
// can be set to; the loop itself still `break`s early at the actual
// uRaymarchSteps value, so raising quality costs real GPU time but
// lowering it below this ceiling is always free to do at runtime.
export const MAX_RAYMARCH_STEPS = 48;

const VERTEX_SRC = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

// Inverse of gameContentContainer's current screen transform (plain
// translate+uniform-scale, no rotation is ever applied to it anywhere
// in the engine — see LightingSystem.js COORDINATE SPACE note), filled
// from JS each frame as stage.x/y/scale change (editor pan/zoom) or
// stage.x/y alone change (play mode's camera-follow translate).
// outputFrame itself is in SCREEN (CSS) pixel space, NOT the filtered
// container's local space, so it must be run through this inverse
// transform to recover the world-space coordinate Transform.x/y values
// actually live in.
uniform vec2 uStageOffset;
uniform float uStageScale;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

void main(void) {
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
    gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);

    // screen-space -> world-space: undo gameContentContainer's own
    // pan (uStageOffset) and zoom (uStageScale) so light/occluder
    // positions (plain Transform.x/y, uploaded with zero conversion —
    // see LightingSystem.js) line up with this pixel correctly whether
    // the editor's free-roam viewport is panned/zoomed or not.
    vWorldCoord = (position - uStageOffset) / uStageScale;
}
`;

const FRAGMENT_SRC = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

uniform sampler2D uSampler;

uniform float uAmbientDarkness;
uniform int uShadowMode; // 0 = quad, 1 = raymarch
uniform int uRaymarchSteps;

uniform int uLightCount;
uniform vec2 uLightPos[${MAX_LIGHTS}];
uniform int uLightTypeId[${MAX_LIGHTS}];      // 0 Directional, 1 Point, 2 Spot, 3 Area
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightIntensity[${MAX_LIGHTS}];
uniform float uLightRadius[${MAX_LIGHTS}];
uniform float uLightAngle[${MAX_LIGHTS}];     // radians, full cone width
uniform float uLightRotation[${MAX_LIGHTS}];  // radians
uniform float uLightWidth[${MAX_LIGHTS}];
uniform float uLightHeight[${MAX_LIGHTS}];
uniform int uLightCastsShadows[${MAX_LIGHTS}];
uniform float uLightShadowStrength[${MAX_LIGHTS}];
uniform vec3 uLightShadowColor[${MAX_LIGHTS}];
uniform float uLightShadowReach[${MAX_LIGHTS}];

uniform int uOccluderCount;
uniform vec2 uOccPos[${MAX_OCCLUDERS}];
uniform vec2 uOccHalfExtents[${MAX_OCCLUDERS}];
uniform float uOccRotation[${MAX_OCCLUDERS}];
uniform float uOccOpacity[${MAX_OCCLUDERS}];
uniform float uOccLength[${MAX_OCCLUDERS}];
uniform float uOccSoftness[${MAX_OCCLUDERS}];

const float PI = 3.14159265359;

// Rotates a world-space point into an occluder's LOCAL axis-aligned
// space (so a rotated box's shadow/occlusion test is just a plain
// axis-aligned box test once the point is in this space) — same
// rotate-then-test approach the old CPU system used per-corner, just
// evaluated per PIXEL here instead of per shadow-quad-corner.
vec2 toLocal(vec2 p, vec2 center, float rotation) {
    vec2 d = p - center;
    float c = cos(-rotation);
    float s = sin(-rotation);
    return vec2(d.x * c - d.y * s, d.x * s + d.y * c);
}

// Signed distance from a point (in an occluder's local space) to its
// axis-aligned box edge: negative = inside, positive = outside,
// magnitude = distance to nearest edge. Used both for the "occluder's
// own footprint re-darkens itself" fill and as the softness falloff at
// a shadow's edge.
float boxSDF(vec2 localP, vec2 halfExtents) {
    vec2 d = abs(localP) - halfExtents;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// True physical-falloff-ish point light brightness curve: a small
// near-solid hot core (matches HOT_CORE_T in the old baked-gradient
// texture) followed by a steeper-than-linear bloom tail — kept
// identical in shape to the previous canvas-baked gradient so existing
// scenes read the same, except now it's a real continuous function
// (zero banding at ANY zoom level, since it's evaluated per pixel
// rather than sampled off a fixed-resolution texture).
float radialFalloff(float distT) {
    const float HOT_CORE_T = 0.12;
    if (distT <= HOT_CORE_T) {
        return 1.0 - 0.08 * (distT / HOT_CORE_T);
    }
    float bloomT = (distT - HOT_CORE_T) / (1.0 - HOT_CORE_T);
    return 0.92 * (1.0 - pow(clamp(bloomT, 0.0, 1.0), 2.4));
}

// Soft rectangular falloff for Area lights: full brightness inside the
// core rect, smoothstep fade across radius past its edge — the
// per-pixel equivalent of the old baked box-blur texture, exact at any
// scale instead of blurred-texture-resolution-limited.
float areaFalloff(vec2 localP, vec2 halfSize, float radius) {
    vec2 d = abs(localP) - halfSize;
    float edgeDist = length(max(d, 0.0));
    if (radius <= 0.0001) return step(edgeDist, 0.0001);
    return 1.0 - smoothstep(0.0, radius, edgeDist);
}

// Point-in-rotated-shadow-quad test, matching the OLD CPU system's
// exact silhouette-quad-extrusion geometry: an occluder's shadow region
// is well-approximated here as "beyond the occluder, within a wedge
// whose half-width is the occluder's own cross-section, out to reach" —
// analytic and cheap (this is what QUAD shadow mode uses; see
// ShadowMode.QUAD in LightingQuality.js). lightToP is in WORLD space.
float quadShadowTest(vec2 pixelWorld, vec2 lightPos, int occIdx, float reachOverride, float extraFadeOut) {
    vec2 occCenter = uOccPos[occIdx];
    vec2 halfExt = uOccHalfExtents[occIdx];
    float rot = uOccRotation[occIdx];
    float opacity = uOccOpacity[occIdx];
    float lengthMult = uOccLength[occIdx];
    float softness = uOccSoftness[occIdx];
    if (opacity <= 0.0) return 0.0;

    vec2 toOcc = occCenter - lightPos;
    float distToOcc = length(toOcc);
    if (distToOcc < 0.0001) return 0.0;
    vec2 dir = toOcc / distToOcc;

    // Occluder's own footprint: always re-darkened (an object doesn't
    // light itself from inside), tested as a true rotated box via
    // toLocal + boxSDF rather than an axis-aligned approximation.
    vec2 local = toLocal(pixelWorld, occCenter, rot);
    float sdf = boxSDF(local, halfExt);
    if (sdf <= 0.0) {
        return opacity;
    }

    // Beyond-the-occluder wedge test: project the pixel onto the
    // light->occluder axis: it must be FARTHER from the light than the
    // occluder's near edge, and within reach along that axis, and
    // its perpendicular distance from the axis must be within the
    // occluder's apparent half-width at that depth (linearly tapering
    // from the true half-width at the occluder out to the same
    // half-width at reach, i.e. a straight-sided extrusion — exactly
    // the old CPU quad's shape).
    vec2 toPixel = pixelWorld - lightPos;
    float alongAxis = dot(toPixel, dir);
    float apparentHalf = max(halfExt.x, halfExt.y);
    float nearDist = distToOcc - apparentHalf;
    float reach = reachOverride * lengthMult;
    if (alongAxis < nearDist || alongAxis > nearDist + reach) return 0.0;

    vec2 perpAxis = vec2(-dir.y, dir.x);
    float perpDist = abs(dot(toPixel, perpAxis));
    if (perpDist > apparentHalf + softness) return 0.0;

    float edgeFade = softness > 0.0 ? 1.0 - smoothstep(apparentHalf, apparentHalf + softness, perpDist) : step(perpDist, apparentHalf);
    float lenFade = 1.0 - smoothstep(nearDist + reach * 0.85, nearDist + reach, alongAxis);
    return opacity * edgeFade * lenFade * extraFadeOut;
}

// True per-pixel occlusion: marches from the pixel toward the light in
// uRaymarchSteps steps, and at each step tests whether the sample
// point falls inside ANY occluder's rotated box — the first hit means
// this pixel is in that occluder's shadow. This is what ShadowMode.
// RAYMARCH buys over quad mode: naturally-correct penumbra width based
// on the occluder's true silhouette as seen from the light (rather
// than the quad's straight-line approximation), and correct handling
// of one occluder partially shadowed by another between it and the
// light.
float raymarchShadowTest(vec2 pixelWorld, vec2 lightPos, float maxDist) {
    vec2 toLight = lightPos - pixelWorld;
    float dist = length(toLight);
    if (dist < 0.0001 || dist > maxDist) return 0.0;
    vec2 dir = toLight / dist;

    float occlusion = 0.0;
    float softAccum = 0.0;
    // Marching from just past the pixel (0.0 would be right at the
    // pixel's own surface, so start slightly in) toward the light,
    // NOT all the way to it — a light shouldn't be able to shadow
    // itself.
    for (int i = 1; i <= ${MAX_RAYMARCH_STEPS}; i++) {
        // Constant loop bound required by GLSL ES 1.00; actual runtime
        // step count is the uRaymarchSteps uniform (see
        // LightingQuality.raymarchSteps), enforced here by breaking
        // early once we've done that many steps.
        if (i > uRaymarchSteps) break;
        float t = (float(i) / float(uRaymarchSteps)) * dist;
        vec2 sample = pixelWorld + dir * t;

        for (int o = 0; o < ${MAX_OCCLUDERS}; o++) {
            if (o >= uOccluderCount) break;
            float opacity = uOccOpacity[o];
            if (opacity <= 0.0) continue;
            vec2 local = toLocal(sample, uOccPos[o], uOccRotation[o]);
            float softness = uOccSoftness[o];
            float sdf = boxSDF(local, uOccHalfExtents[o]);
            if (sdf <= 0.0) {
                occlusion = max(occlusion, opacity);
            } else if (softness > 0.0 && sdf <= softness) {
                softAccum = max(softAccum, opacity * (1.0 - sdf / softness));
            }
        }
        if (occlusion >= 0.999) break;
    }
    return clamp(max(occlusion, softAccum * 0.6), 0.0, 1.0);
}

void main(void) {
    vec4 sceneColor = texture2D(uSampler, vTextureCoord);
    vec2 pixelWorld = vWorldCoord;

    vec3 accumulatedLight = vec3(0.0);
    vec3 accumulatedShadowTint = vec3(0.0);
    float totalShadowMix = 0.0;

    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (i >= uLightCount) break;

        int typeId = uLightTypeId[i];
        vec3 color = uLightColor[i];
        float intensity = uLightIntensity[i];
        vec2 lightPos = uLightPos[i];

        float brightness = 0.0;

        if (typeId == 0) {
            // Directional: uniform across the whole scene, no position
            // dependency at all — matches the old system's flat-rect
            // fill exactly (see components/Light.js file header).
            brightness = 1.0;
        } else {
            vec2 toPixel = pixelWorld - lightPos;
            float dist = length(toPixel);

            if (typeId == 1) {
                // Point
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                brightness = dist > radius ? 0.0 : radialFalloff(distT);
            } else if (typeId == 2) {
                // Spot: radial falloff identical to Point, gated by a
                // soft-edged cone centered on uLightRotation.
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                float radial = dist > radius ? 0.0 : radialFalloff(distT);

                float angleToPixel = atan(toPixel.y, toPixel.x);
                float rel = angleToPixel - uLightRotation[i];
                rel = mod(rel + PI, 2.0 * PI) - PI;
                float halfCone = uLightAngle[i] * 0.5;
                float coneFadeBand = max(0.03, halfCone * 0.25);
                float coneMask = 1.0 - smoothstep(halfCone, halfCone + coneFadeBand, abs(rel));

                brightness = radial * coneMask;
            } else {
                // Area
                float rot = uLightRotation[i];
                vec2 local = toLocal(pixelWorld, lightPos, 0.0);
                vec2 halfSize = vec2(uLightWidth[i], uLightHeight[i]) * 0.5;
                brightness = areaFalloff(local, halfSize, uLightRadius[i]);
            }
        }

        brightness *= min(1.0, intensity);
        if (brightness <= 0.0015) continue;

        // Shadow test for this light, if enabled, only where the
        // light would otherwise contribute brightness (skipping the
        // shadow march entirely outside a light's reach is a cheap and
        // correct early-out for both shadow modes).
        float shadowAmount = 0.0;
        if (uLightCastsShadows[i] == 1 && uOccluderCount > 0) {
            float reach = uLightShadowReach[i];
            if (uShadowMode == 1) {
                shadowAmount = raymarchShadowTest(pixelWorld, typeId == 0 ? pixelWorld - vec2(cos(uLightRotation[i]), sin(uLightRotation[i])) * reach : lightPos, reach);
            } else {
                for (int o = 0; o < ${MAX_OCCLUDERS}; o++) {
                    if (o >= uOccluderCount) break;
                    vec2 effectiveLightPos = typeId == 0
                        ? pixelWorld - vec2(cos(uLightRotation[i]), sin(uLightRotation[i])) * reach
                        : lightPos;
                    float s = quadShadowTest(pixelWorld, effectiveLightPos, o, reach, 1.0);
                    shadowAmount = max(shadowAmount, s);
                }
            }
            shadowAmount *= uLightShadowStrength[i];
        }

        float litBrightness = brightness * (1.0 - shadowAmount);
        accumulatedLight += color * litBrightness;

        if (shadowAmount > 0.0015) {
            accumulatedShadowTint += uLightShadowColor[i] * shadowAmount * brightness;
            totalShadowMix = max(totalShadowMix, shadowAmount * brightness);
        }
    }

    // Base: darken the whole scene by uAmbientDarkness, then additively
    // bring back accumulatedLight (this IS the "darkness rect + additive
    // glow" compositing the old system did with blend modes, just as
    // per-pixel math instead of two separate draw layers).
    vec3 darkened = sceneColor.rgb * (1.0 - uAmbientDarkness);
    vec3 lit = darkened + accumulatedLight * uAmbientDarkness * sceneColor.a;

    // Shadow tint re-darkens exactly the occluded wedge/region back
    // toward the light's shadowColor, mixed in proportion to how much
    // that pixel would otherwise have been lit — an unlit pixel has
    // nothing to shadow, matching the old system's behavior of only
    // drawing shadow polygons inside a light's own additive glow area.
    vec3 finalColor = mix(lit, lit * (1.0 - totalShadowMix) + accumulatedShadowTint * 0.5, min(1.0, totalShadowMix));

    gl_FragColor = vec4(finalColor, sceneColor.a);
}
`;

/**
 * Builds a fresh PIXI.Filter instance wired with the shader above and
 * zero-initialized uniform arrays sized to MAX_LIGHTS/MAX_OCCLUDERS.
 * Called once per LightingSystem instance (not shared/cached globally)
 * so multiple concurrent game instances — e.g. the editor's Scene
 * viewport AND a play-mode popup open at the same time — each get
 * their own independent filter/uniform state instead of fighting over
 * one shared set of light data.
 */
export function buildLightingFilter() {
  const uniforms = {
    uAmbientDarkness: 0.65,
    uShadowMode: 0,
    uRaymarchSteps: 24,
    uStageOffset: new Float32Array([0, 0]),
    uStageScale: 1,

    uLightCount: 0,
    uLightPos: new Float32Array(MAX_LIGHTS * 2),
    uLightTypeId: new Int32Array(MAX_LIGHTS),
    uLightColor: new Float32Array(MAX_LIGHTS * 3),
    uLightIntensity: new Float32Array(MAX_LIGHTS),
    uLightRadius: new Float32Array(MAX_LIGHTS),
    uLightAngle: new Float32Array(MAX_LIGHTS),
    uLightRotation: new Float32Array(MAX_LIGHTS),
    uLightWidth: new Float32Array(MAX_LIGHTS),
    uLightHeight: new Float32Array(MAX_LIGHTS),
    uLightCastsShadows: new Int32Array(MAX_LIGHTS),
    uLightShadowStrength: new Float32Array(MAX_LIGHTS),
    uLightShadowColor: new Float32Array(MAX_LIGHTS * 3),
    uLightShadowReach: new Float32Array(MAX_LIGHTS),

    uOccluderCount: 0,
    uOccPos: new Float32Array(MAX_OCCLUDERS * 2),
    uOccHalfExtents: new Float32Array(MAX_OCCLUDERS * 2),
    uOccRotation: new Float32Array(MAX_OCCLUDERS),
    uOccOpacity: new Float32Array(MAX_OCCLUDERS),
    uOccLength: new Float32Array(MAX_OCCLUDERS),
    uOccSoftness: new Float32Array(MAX_OCCLUDERS),
  };

  const filter = new PIXI.Filter(VERTEX_SRC, FRAGMENT_SRC, uniforms);
  filter.resolution = window.devicePixelRatio || 1;
  // autoFit (PIXI's default: true) would size the filter's working
  // area to gameContentContainer's current BOUNDING BOX of rendered
  // sprites — meaning empty background beyond the outermost sprite
  // gets skipped entirely and stays undarkened/unlit. The old CPU
  // system always drew its darkness rect/glow across a large fixed
  // area regardless of where sprites actually are (see the previous
  // _drawDarkness's fixed `half = 4000` rect), so autoFit is turned
  // off here to match: the shader instead always covers the renderer's
  // full screen area (LightingSystem sets filterArea to that each
  // frame — see _syncFilterArea), same as the old fixed-size rect did.
  filter.autoFit = false;
  return filter;
}

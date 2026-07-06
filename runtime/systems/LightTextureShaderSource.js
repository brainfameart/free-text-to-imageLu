/**
 * runtime/systems/LightTextureShaderSource.js
 *
 * PHASE 1 of the Unity-URP-2D-style two-phase pipeline (see
 * LightingSystem.js file header for the full pipeline description).
 *
 * This shader draws ONLY light shapes: radial/cone/rect falloff per
 * light type, summed together, with shadow occlusion subtracted where
 * a shadow-casting light's rays are blocked by a ShadowCaster. It has
 * NO knowledge of sprites at all — no uSampler, no scene texture, no
 * per-object color. This is exactly Unity's "Light Render Texture":
 * a screen-space buffer that only contains light color/intensity,
 * rendered once per frame regardless of how many sprites exist.
 *
 * Output channels (see main()):
 *  - rgb: accumulated light color (ambient base + every light's
 *    contribution, additive — matches Unity's per-blend-style Light
 *    Render Texture, which is likewise additive-blended per light).
 *  - a:   total shadow mix (0 = fully lit relative to occluders, 1 =
 *    fully in shadow) — carried in the alpha channel so Phase 2
 *    (SpriteLightFilter.js) can optionally tint shadowed sprite pixels
 *    toward a shadow color WITHOUT this shader needing to know
 *    anything about sprite pixels itself.
 *
 * WHY THIS FIXES "sprites go pure white / pure black": because this
 * buffer holds ONLY light values, sampling it later can only ever
 * MULTIPLY against a sprite's own texture color (see
 * SpriteLightFilter.js) — a light value can dim or brighten a sprite's
 * own color, but it structurally cannot replace it with a flat color,
 * the way the old single-pass filter's additive term could.
 *
 * RUNTIME-ONLY FILE (depends on PIXI's Filter, not on the editor).
 */

// Same caps/tradeoffs as before — see the old LightingShaderSource.js
// for the uniform-budget math; unchanged here since the same light/
// occluder data still needs to reach the GPU, just into a different
// shader with a different job.
export const MAX_LIGHTS = 32;
export const MAX_OCCLUDERS = 24;
export const MAX_RAYMARCH_STEPS = 48;

const VERTEX_SRC = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec4 inputSize;
uniform vec4 outputFrame;

// Inverse of gameContentContainer's current screen transform (plain
// translate+uniform-scale — see LightingSystem.js COORDINATE SPACE
// note), filled from JS each frame so light/occluder world positions
// line up with this pixel regardless of editor pan/zoom or play-mode
// camera-follow translate.
uniform vec2 uStageOffset;
uniform float uStageScale;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

void main(void) {
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
    gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
    vWorldCoord = (position - uStageOffset) / uStageScale;
}
`;

const FRAGMENT_SRC = `
precision mediump float;

varying vec2 vTextureCoord;
varying vec2 vWorldCoord;

uniform float uAmbientDarkness;
uniform int uShadowMode; // 0 = quad, 1 = raymarch
uniform int uRaymarchSteps;
// Running scene clock (seconds), fed from LightingSystem.js each
// frame — only God Rays uses this, to very slowly drift its streak
// pattern the way real light shafts shimmer as dust/haze in the air
// moves, instead of looking like a static painted-on cone.
uniform float uTime;

uniform int uLightCount;
uniform vec2 uLightPos[${MAX_LIGHTS}];
uniform int uLightTypeId[${MAX_LIGHTS}];      // 0 Directional, 1 Point, 2 Spot, 3 Area, 4 GodRays
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

vec2 toLocal(vec2 p, vec2 center, float rotation) {
    vec2 d = p - center;
    float c = cos(-rotation);
    float s = sin(-rotation);
    return vec2(d.x * c - d.y * s, d.x * s + d.y * c);
}

float boxSDF(vec2 localP, vec2 halfExtents) {
    vec2 d = abs(localP) - halfExtents;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Physical-falloff-ish point light brightness curve: small near-solid
// hot core followed by a steeper-than-linear bloom tail. This is what
// makes a light look like it's actually SHINING from a source point
// rather than a uniform flat disc.
float radialFalloff(float distT) {
    const float HOT_CORE_T = 0.12;
    if (distT <= HOT_CORE_T) {
        return 1.0 - 0.08 * (distT / HOT_CORE_T);
    }
    float bloomT = (distT - HOT_CORE_T) / (1.0 - HOT_CORE_T);
    return 0.92 * (1.0 - pow(clamp(bloomT, 0.0, 1.0), 2.4));
}

// Strictly contained within the light's own rectangle — matches its
// gizmo box exactly, with NO glow bleeding past the drawn outline
// (previously the radius parameter extended the visible glow OUTWARD
// past the box edges by up to that many world units, which read as
// the light "shining outside" its own shape). The radius parameter
// here instead controls how far the soft edge feathers INWARD from
// the box's own edge, clamped so it can never eat more than half the
// box.
float areaFalloff(vec2 localP, vec2 halfSize, float radius) {
    vec2 d = abs(localP) - halfSize;
    if (d.x > 0.0 || d.y > 0.0) return 0.0;
    float insideEdgeDist = -max(d.x, d.y);
    float feather = clamp(radius, 0.0001, max(0.0001, min(halfSize.x, halfSize.y)));
    return smoothstep(0.0, feather, insideEdgeDist);
}

// Cheap value-noise-ish hash, used only to break up God Rays' streak
// pattern so it reads as irregular dust/haze rather than a perfectly
// periodic sine grating (Unity's Light Shaft/Volumetric 2D packages
// all layer noise on top of a pure radial gradient for this reason).
float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
}

// God Rays realism pass #2 — reworked from scratch to match the
// attached Unity "2D Lights & Shadows" reference: soft, hazy, layered
// volumetric shafts breaking through foliage, NOT a hard-edged cone
// with a barcode of evenly-spaced lines. Three deliberate departures
// from the previous version:
//   1. NO hard cone boundary at all. Real light shafts have no visible
//      edge line — they just gradually dim toward the sides. The cross-
//      beam profile is a smooth bell curve (soft Gaussian-ish falloff)
//      instead of a flat-top mask with a thin feathered edge.
//   2. Far fewer, WIDE, irregular-brightness bands (hashed per-band,
//      not a continuous sine grating) so it reads as a handful of
//      distinct hazy shafts of different strength, exactly like the
//      reference images — never a mechanically even barcode.
//   3. A gentle low-frequency drift + a much softer/hazier longitudinal
//      falloff (bright and fairly even along most of the shaft, then a
//      slow fade) instead of a bright hot core with a steep tail — the
//      reference shafts stay visible and soft for most of their length.
float godRaysBrightness(vec2 toPixel, float dist, float radius, float rotation, float halfCone) {
    float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);

    float angleToPixel = atan(toPixel.y, toPixel.x);
    float rel = angleToPixel - rotation;
    rel = mod(rel + PI, 2.0 * PI) - PI;
    float coneT = rel / max(halfCone, 0.0001); // unclamped: lets the bell curve tail off naturally

    // Soft, edgeless cross-beam profile — brightest along the light's
    // aim direction, smoothly (not linearly) dimming toward the sides
    // with no visible boundary line, matching the hazy, undefined edges
    // of the reference shafts.
    float coneMask = exp(-coneT * coneT * 1.15);
    if (coneMask <= 0.0025) return 0.0;

    // Longitudinal haze: stays fairly bright and even for most of the
    // shaft's length, then softly washes out — no sharp "hot core then
    // steep falloff" knee.
    float longFade = dist > radius ? 0.0 : exp(-distT * distT * 1.15) * mix(1.0, 0.55, distT);

    // A handful (not dozens) of irregular, hashed-brightness bands
    // spanning the beam's width, blended smoothly into their neighbors
    // so edges between bands are soft, never a crisp stripe.
    const float BAND_COUNT = 5.0;
    float bandF = (coneT * 0.5 + 0.5) * BAND_COUNT + dist * 0.0022 + uTime * 0.035;
    float bandIdx = floor(bandF);
    float bandLocal = smoothstep(0.0, 1.0, fract(bandF));
    float bandA = hash1(bandIdx);
    float bandB = hash1(bandIdx + 1.0);
    float bandBrightness = mix(bandA, bandB, bandLocal);
    // Keep every band visibly hazy — never lets the gaps between rays
    // go fully dark, matching how the reference shafts overlap into a
    // continuous glow rather than showing black gaps.
    bandBrightness = mix(0.6, 1.0, bandBrightness);

    // A finer, slower haze/dust shimmer riding on top of the bands —
    // wide, soft sine lobes (not a tight barcode) so close-up the shaft
    // still reads as drifting haze rather than flat bands.
    float fineF = (coneT * 0.5 + 0.5) * 11.0 + dist * 0.006 - uTime * 0.08;
    float fine = mix(0.82, 1.0, 0.5 + 0.5 * sin(fineF));

    float brightness = coneMask * longFade * bandBrightness * fine;

    // Gentle glow right at the light source so its origin doesn't look
    // clipped/flat, softened into the rest of the shaft rather than a
    // hard bright dot.
    brightness = max(brightness, coneMask * exp(-distT * distT * 22.0) * 0.7);

    return brightness;
}

float quadShadowTest(vec2 pixelWorld, vec2 lightPos, vec2 occCenter, vec2 halfExt, float rot, float opacity, float lengthMult, float softness, float reachOverride, float extraFadeOut) {
    if (opacity <= 0.0) return 0.0;

    vec2 toOcc = occCenter - lightPos;
    float distToOcc = length(toOcc);
    if (distToOcc < 0.0001) return 0.0;
    vec2 dir = toOcc / distToOcc;

    vec2 toPixel = pixelWorld - lightPos;
    float alongAxis = dot(toPixel, dir);
    float apparentHalf = max(halfExt.x, halfExt.y);
    // Shadows start at the occluder's FAR edge (relative to the
    // light), never inside its own silhouette. An object must never
    // darken ITSELF — only the surfaces behind it — matching Unity's
    // Shadow Caster 2D, where a sprite never self-shadows from its
    // own light. (Previously this tested "is the shaded pixel
    // literally inside this occluder's own box" and returned full
    // shadow if so, plus started the shadow band at the occluder's
    // NEAR edge — both of which made an object cast its own shadow
    // onto its own body.)
    float farDist = distToOcc + apparentHalf;
    float reach = reachOverride * lengthMult;
    if (alongAxis < farDist || alongAxis > farDist + reach) return 0.0;

    vec2 perpAxis = vec2(-dir.y, dir.x);
    float perpDist = abs(dot(toPixel, perpAxis));
    if (perpDist > apparentHalf + softness) return 0.0;

    float edgeFade = softness > 0.0 ? 1.0 - smoothstep(apparentHalf, apparentHalf + softness, perpDist) : step(perpDist, apparentHalf);
    float lenFade = 1.0 - smoothstep(farDist + reach * 0.85, farDist + reach, alongAxis);
    return opacity * edgeFade * lenFade * extraFadeOut;
}

float raymarchShadowTest(vec2 pixelWorld, vec2 lightPos, float maxDist) {
    vec2 toLight = lightPos - pixelWorld;
    float dist = length(toLight);
    if (dist < 0.0001 || dist > maxDist) return 0.0;
    vec2 dir = toLight / dist;

    // Bias the marched ray's START away from the shaded pixel itself
    // (a standard shadow-acne-style bias) so an occluder can never
    // register itself as blocking its own surface — a shadow should
    // only ever land on OTHER surfaces behind an occluder, never on
    // the occluder's own body, matching Unity's Shadow Caster 2D.
    // Without this, a raymarch step at t≈0 that happens to already be
    // inside the very occluder the shaded pixel belongs to reads as
    // "occluded," self-shadowing the object for its entire silhouette.
    float tStart = min(dist, max(2.0, dist * 0.08));

    float occlusion = 0.0;
    float softAccum = 0.0;
    for (int i = 1; i <= ${MAX_RAYMARCH_STEPS}; i++) {
        if (i > uRaymarchSteps) break;
        float t = tStart + (float(i) / float(uRaymarchSteps)) * max(0.0, dist - tStart);
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
    vec2 pixelWorld = vWorldCoord;

    // Ambient base: the light value present EVERYWHERE, lit or not —
    // this is Unity's "2D global light" concept baked directly into
    // the buffer's own base color instead of a separate light type, so
    // Phase 2 never needs a special no-light-reaches-here case: it's
    // always sampling a real, already-ambient-lit value.
    vec3 accumulatedLight = vec3(1.0 - uAmbientDarkness);
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
            brightness = 1.0;
        } else {
            vec2 toPixel = pixelWorld - lightPos;
            float dist = length(toPixel);

            if (typeId == 1) {
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                brightness = dist > radius ? 0.0 : radialFalloff(distT);
            } else if (typeId == 2) {
                float radius = uLightRadius[i];
                float distT = clamp(dist / max(radius, 0.0001), 0.0, 1.0);
                float radial = dist > radius ? 0.0 : radialFalloff(distT);

                float angleToPixel = atan(toPixel.y, toPixel.x);
                float rel = angleToPixel - uLightRotation[i];
                rel = mod(rel + PI, 2.0 * PI) - PI;
                float halfCone = uLightAngle[i] * 0.5;
                // Feathers INWARD from the cone's own edge so the lit
                // area never extends past halfCone — matching the
                // gizmo's cone outline exactly instead of visibly
                // "shining outside" it.
                float coneFadeBand = max(0.03, halfCone * 0.25);
                float coneMask = 1.0 - smoothstep(halfCone - coneFadeBand, halfCone, abs(rel));

                brightness = radial * coneMask;
            } else if (typeId == 4) {
                brightness = godRaysBrightness(toPixel, dist, uLightRadius[i], uLightRotation[i], uLightAngle[i] * 0.5);
            } else {
                vec2 local = toLocal(pixelWorld, lightPos, 0.0);
                vec2 halfSize = vec2(uLightWidth[i], uLightHeight[i]) * 0.5;
                brightness = areaFalloff(local, halfSize, uLightRadius[i]);
            }
        }

        // intensity is NOT clamped to 1.0 — Light.intensity supports
        // ">1 = overbright" by design (see components/Light.js), and a
        // hot/overbright light needs to be able to push this buffer's
        // value past 1.0 so Phase 2 can render a real "shine," not just
        // a 1:1 recolor.
        brightness *= max(0.0, intensity);
        if (brightness <= 0.0015) continue;

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
                    float s = quadShadowTest(pixelWorld, effectiveLightPos, uOccPos[o], uOccHalfExtents[o], uOccRotation[o], uOccOpacity[o], uOccLength[o], uOccSoftness[o], reach, 1.0);
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

    // Shadow tint is baked into rgb here too (still purely a LIGHT
    // value, no sprite color involved) so Phase 2 stays a single
    // multiply with no extra shadow-specific logic of its own.
    vec3 finalLight = mix(accumulatedLight, accumulatedLight * (1.0 - totalShadowMix) + accumulatedShadowTint * 0.5, min(1.0, totalShadowMix));

    gl_FragColor = vec4(max(finalLight, 0.0), clamp(totalShadowMix, 0.0, 1.0));
}
`;

/**
 * Builds a fresh PIXI.Filter that renders the light buffer described
 * above. Applied to a dedicated offscreen container (see
 * LightingSystem.js's _renderLightTexture) rather than the sprite
 * container — this filter has zero knowledge of sprites and must never
 * be applied directly to gameContentContainer.
 */
export function buildLightTextureFilter() {
  const uniforms = {
    uAmbientDarkness: 0.65,
    uShadowMode: 0,
    uRaymarchSteps: 24,
    uTime: 0,
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
  filter.autoFit = false;
  return filter;
}

/**
 * editor/panels/Inspector.js
 *
 * Component inspector for the currently selected entity. Reads real
 * component data from the entity (via editorState.world) and renders
 * editable fields wired with data-field/data-axis attributes that
 * EditorEvents.js uses to write values back onto the live component.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn, row, numInput, vec3Input, dropdownInput, section } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { CAMERA, CameraAspectMode } from "../../runtime/components/Camera.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { RIGIDBODY_2D, BodyType } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { CHARACTER_CONTROLLER, ControllerType } from "../../runtime/components/CharacterController.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS } from "../../runtime/components/LightingSettings.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { TILESET } from "../../runtime/components/Tileset.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { SCRIPT } from "../../runtime/components/Script.js";
import { ShadowMode } from "../../runtime/systems/LightingQuality.js";
import { getCameraResolution } from "../../runtime/core/CameraUtils.js";
import { getSpriteAsset, getAudioAsset, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { getAllScripts } from "../scripting/ScriptStorage.js";

export function renderInspector() {
  const world = editorState.world;
  const entity = world ? world.getEntity(editorState.selectedId) : null;

  if (!entity) {
    return (
      '<div class="inspector-panel">' +
      '<div class="tabbar">' +
      tabBtn(true, "Inspector", "info") +
      "</div>" +
      '<div class="inspector-empty">No object selected</div>' +
      "</div>"
    );
  }

  let body = "";

  const transform = entity.getComponent(TRANSFORM);
  if (transform) {
    body += section(
      editorState.sectionsOpen,
      "transform",
      "Transform",
      "move",
      row("Position", vec3Input(transform.x, transform.y, transform.z, "Transform.position")) +
        row("Rotation", vec3Input(transform.rotation, 0, 0, "Transform.rotation")) +
        row("Scale", vec3Input(transform.scaleX, transform.scaleY, 1, "Transform.scale"))
    );
  }

  const camera = entity.getComponent(CAMERA);
  if (camera) {
    const resolution = getCameraResolution(camera);

    let resolutionFieldsHtml = "";
    if (camera.aspectMode === CameraAspectMode.LANDSCAPE) {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.landscapeWidth, "Camera.landscapeWidth") +
          numInput("H", camera.landscapeHeight, "Camera.landscapeHeight") +
          "</div>"
      );
    } else if (camera.aspectMode === CameraAspectMode.PORTRAIT) {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.portraitWidth, "Camera.portraitWidth") +
          numInput("H", camera.portraitHeight, "Camera.portraitHeight") +
          "</div>"
      );
    } else if (camera.aspectMode === CameraAspectMode.SQUARE) {
      resolutionFieldsHtml = row("Size (px)", numInput("", camera.squareSize, "Camera.squareSize"));
    } else {
      resolutionFieldsHtml = row(
        "Resolution",
        '<div style="display:flex;gap:4px;width:100%;">' +
          numInput("W", camera.customWidth, "Camera.customWidth") +
          numInput("H", camera.customHeight, "Camera.customHeight") +
          "</div>"
      );
    }

    body += section(
      editorState.sectionsOpen,
      "camera",
      "Camera",
      "camera",
      row("Clear Flags", dropdownInput(["Solid Color", "Skybox", "Depth only", "Don't Clear"], "Solid Color")) +
        row(
          "Background",
          '<input type="color" class="color-swatch-input" value="' +
            camera.backgroundColor +
            '" data-field="Camera.backgroundColor" />'
        ) +
        row("Projection", dropdownInput(["Orthographic", "Perspective"], camera.projection, "Camera.projection")) +
        row("Size", numInput("", camera.size, "Camera.size")) +
        row(
          "Clipping Planes",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("N", camera.nearClip, "Camera.nearClip") +
            numInput("F", camera.farClip, "Camera.farClip") +
            "</div>"
        ) +
        row(
          "Orientation",
          dropdownInput(
            [CameraAspectMode.LANDSCAPE, CameraAspectMode.PORTRAIT, CameraAspectMode.SQUARE, CameraAspectMode.CUSTOM],
            camera.aspectMode,
            "Camera.aspectMode"
          )
        ) +
        resolutionFieldsHtml +
        '<div class="row"><span class="row-label">Export Size</span><div class="row-content"><span class="export-size-readout">' +
        resolution.width + " x " + resolution.height + " px</span></div></div>" +
        row(
          "Pseudo 3D (Z Scale)",
          '<input type="checkbox" data-field="Camera.enablePseudo3D" style="accent-color:#2C5D87;margin:0;"' +
            (camera.enablePseudo3D ? " checked" : "") +
            "/>"
        )
    );
  }

  const spriteRenderer = entity.getComponent(SPRITE_RENDERER);
  if (spriteRenderer) {
    const spriteAsset = spriteRenderer.spriteKey ? getSpriteAsset(spriteRenderer.spriteKey) : null;
    const spriteDisplayName = spriteAsset ? spriteAsset.name : spriteRenderer.spriteKey || "None";
    body += section(
      editorState.sectionsOpen,
      "sprite",
      "Sprite Renderer",
      "layers",
      row(
        "Sprite",
        '<div class="sprite-row"><div class="sprite-box">' +
          spriteDisplayName +
          '</div><button class="sprite-pick"><span></span></button></div>'
      ) +
        row(
          "Color",
          '<input type="color" class="color-swatch-input" value="' +
            spriteRenderer.color +
            '" data-field="SpriteRenderer.color" />'
        ) +
        row(
          "Opacity",
          numInput("", spriteRenderer.opacity != null ? spriteRenderer.opacity : 1, "SpriteRenderer.opacity")
        ) +
        row(
          "Flip",
          '<div class="flip-row"><label><input type="checkbox" data-field="SpriteRenderer.flipX"' +
            (spriteRenderer.flipX ? " checked" : "") +
            "/> X</label><label><input type=\"checkbox\" data-field=\"SpriteRenderer.flipY\"" +
            (spriteRenderer.flipY ? " checked" : "") +
            "/> Y</label></div>"
        )
    );
  }

  const light = entity.getComponent(LIGHT);
  if (light) {
    let typeSpecificHtml = "";
    if (light.type === LightType.POINT) {
      typeSpecificHtml = row("Radius", numInput("", light.radius, "Light.radius"));
    } else if (light.type === LightType.SPOT) {
      typeSpecificHtml =
        row("Radius", numInput("", light.radius, "Light.radius")) +
        row("Spot Angle", numInput("", light.angle, "Light.angle")) +
        row(
          "Direction",
          '<div class="static-body-note" style="padding:2px 0;color:#8a93a0;font-size:10px;">Aimed using this object\'s Transform &gt; Rotation.</div>'
        );
    } else if (light.type === LightType.AREA) {
      typeSpecificHtml =
        row(
          "Size",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("W", light.width, "Light.width") +
            numInput("H", light.height, "Light.height") +
            "</div>"
        ) + row("Falloff Radius", numInput("", light.radius, "Light.radius"));
    } else if (light.type === LightType.GOD_RAYS) {
      typeSpecificHtml =
        row("Radius", numInput("", light.radius, "Light.radius")) +
        row("Beam Angle", numInput("", light.angle, "Light.angle")) +
        row(
          "Direction",
          '<div class="static-body-note" style="padding:2px 0;color:#8a93a0;font-size:10px;">Aimed using this object\'s Transform &gt; Rotation.</div>'
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "God Rays cast bright, streaked shafts of light through the beam — like sunlight breaking through clouds or a window — instead of a flat cone." +
        "</div>";
    } else if (light.type === LightType.FREEFORM) {
      const pointCount = light.points ? light.points.length : 0;
      typeSpecificHtml =
        row("Edge Feather", numInput("", light.radius, "Light.radius")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Shape drawn by dragging points directly in the Scene view (" + pointCount + " points). " +
        "Double-click an edge to add a point; right-click (or Alt-click) a point to remove it." +
        "</div>";
    } else {
      // Directional: no position/radius dependency for its GLOW — it
      // uniformly lights the whole scene — but its rotation still
      // matters for shadow direction when Cast Shadows is on below (see
      // "just like the sun" note there), so this stays informational
      // rather than implying rotation is irrelevant.
      typeSpecificHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Directional lights ignore position and reach for lighting — they light the entire scene evenly, like sunlight. Rotation still controls shadow direction if Cast Shadows is on." +
        "</div>";
    }

    const shadowFields = light.castShadows
      ? row(
          "Shadow Color",
          '<input type="color" class="color-swatch-input" value="' +
            light.shadowColor +
            '" data-field="Light.shadowColor" />'
        ) +
        row("Shadow Strength", numInput("", light.shadowStrength, "Light.shadowStrength")) +
        (light.type === LightType.DIRECTIONAL
          ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Parallel shadows, like the sun: every Shadow Caster's shadow points the same way, set ONLY by this light's rotation — moving this light does nothing to its shadows." +
            "</div>"
          : '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Casts real-time shadows from every object with a Shadow Caster component (see below)." +
            "</div>")
      : "";

    body += section(
      editorState.sectionsOpen,
      "light",
      "Light",
      "lightbulb",
      row("Type", dropdownInput(Object.values(LightType), light.type, "Light.type")) +
        row(
          "Color",
          '<input type="color" class="color-swatch-input" value="' +
            light.color +
            '" data-field="Light.color" />'
        ) +
        row("Intensity", numInput("", light.intensity, "Light.intensity")) +
        typeSpecificHtml +
        row(
          "Affects World",
          '<input type="checkbox" data-field="Light.castsOnWorld" style="accent-color:#2C5D87;margin:0;"' +
            (light.castsOnWorld ? " checked" : "") +
            "/>"
        ) +
        row(
          "Cast Shadows",
          '<input type="checkbox" data-field="Light.castShadows" style="accent-color:#2C5D87;margin:0;"' +
            (light.castShadows ? " checked" : "") +
            "/>"
        ) +
        shadowFields +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Light" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const audioSource = entity.getComponent(AUDIO_SOURCE);
  if (audioSource) {
    const audioAsset = audioSource.audioKey ? getAudioAsset(audioSource.audioKey) : null;
    const allAudioAssets = getAllAudioAssets();
    // Every imported Audio asset becomes a selectable option here, keyed
    // by its stable asset key (option value) but labeled with its
    // friendly name (option text) — a plain dropdownInput() can't do
    // that split (it renders the same string as both value and label),
    // so this builds the <select> markup directly. Falls back to a
    // disabled placeholder option when the current audioKey doesn't
    // match any imported asset (e.g. it was deleted from the project),
    // so the picker still shows something meaningful instead of quietly
    // snapping to the first asset in the list.
    const audioOptionsHtml =
      (audioSource.audioKey && !audioAsset
        ? '<option value="' + audioSource.audioKey + '" selected disabled>' +
          "Missing: " + audioSource.audioKey +
          "</option>"
        : !audioSource.audioKey
          ? '<option value="" selected disabled>None</option>'
          : "") +
      allAudioAssets
        .map(
          (a) =>
            '<option value="' + a.key + '"' + (a.key === audioSource.audioKey ? " selected" : "") + ">" +
            a.name +
            "</option>"
        )
        .join("");
    const audioClipPickerHtml = allAudioAssets.length
      ? '<div class="dropdown-input"><select data-field="AudioSource.audioKey">' +
        audioOptionsHtml +
        "</select>" +
        icon("chevrondown", 10, "chev") +
        "</div>"
      : '<div class="sprite-row"><div class="sprite-box">No audio imported</div></div>';

    const distanceFieldsHtml = audioSource.is3D
      ? row("Min Distance", numInput("", audioSource.minDistance, "AudioSource.minDistance")) +
        row("Max Distance", numInput("", audioSource.maxDistance, "AudioSource.maxDistance")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Full volume within Min Distance of the camera, fading out linearly to silent by Max Distance — shown as the two circles around this object in the Scene view." +
        "</div>"
      : '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "2D audio plays at a constant volume everywhere in the scene, regardless of this object's position — use it for background music or UI sounds." +
        "</div>";

    body += section(
      editorState.sectionsOpen,
      "audiosource",
      "Audio Source",
      "music",
      row("Clip", audioClipPickerHtml) +
        row("Mode", dropdownInput(["2D", "3D"], audioSource.is3D ? "3D" : "2D", "AudioSource.is3DLabel")) +
        row("Volume", numInput("", audioSource.volume, "AudioSource.volume")) +
        row(
          "Loop",
          '<input type="checkbox" data-field="AudioSource.loop" style="accent-color:#2C5D87;margin:0;"' +
            (audioSource.loop ? " checked" : "") +
            "/>"
        ) +
        row(
          "Play On Awake",
          '<input type="checkbox" data-field="AudioSource.autoplay" style="accent-color:#2C5D87;margin:0;"' +
            (audioSource.autoplay ? " checked" : "") +
            "/>"
        ) +
        distanceFieldsHtml +
        '<button class="removecomp-btn" data-action="remove-component" data-component="AudioSource" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const tileset = entity.getComponent(TILESET);
  if (tileset) {
    const filledCount = Object.values(tileset.slots).filter(Boolean).length;
    body += section(
      editorState.sectionsOpen,
      "tileset",
      "Tileset",
      "grid",
      row("Name", '<input type="text" data-field="Tileset.name" value="' + tileset.name + '" style="width:100%;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>') +
        row("Tile Size", numInput("W", tileset.tileWidth, "Tileset.tileWidth") + numInput("H", tileset.tileHeight, "Tileset.tileHeight")) +
        row("Slots Filled", '<span style="color:#8a93a0;font-size:11px;">' + filledCount + " / 16</span>") +
        '<button class="animwin-btn" data-action="open-tileset-editor" data-entity="' + entity.id + '" style="width:100%;margin-top:4px;">' +
        icon("grid", 12) +
        " Open Tileset Editor</button>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Tileset" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const tilemap = entity.getComponent(TILEMAP);
  if (tilemap) {
    // Every OTHER entity in the scene that carries a Tileset is a valid
    // assignment target — Tilemap references a Tileset by entity id
    // (not by copying its data), matching Light/ShadowCaster's existing
    // reference-by-id convention elsewhere in this codebase (see
    // Tilemap.js's file header for why).
    const tilesetEntities = world ? world.getAllEntities().filter((e) => e.hasComponent(TILESET)) : [];
    const cellCount = Object.keys(tilemap.cells).length;
    const tilesetOptionsHtml =
      (!tilemap.tilesetEntityId ? '<option value="" selected disabled>None</option>' : "") +
      tilesetEntities
        .map(
          (e) =>
            '<option value="' + e.id + '"' + (e.id === tilemap.tilesetEntityId ? " selected" : "") + ">" +
            e.name +
            "</option>"
        )
        .join("");
    const tilesetPickerHtml = tilesetEntities.length
      ? '<div class="dropdown-input"><select data-field="Tilemap.tilesetEntityId">' +
        tilesetOptionsHtml +
        "</select>" +
        icon("chevrondown", 10, "chev") +
        "</div>"
      : '<div class="sprite-row"><div class="sprite-box">No Tileset in scene — add one to an object first</div></div>';

    body += section(
      editorState.sectionsOpen,
      "tilemap",
      "Tilemap",
      "grid",
      row("Tileset", tilesetPickerHtml) +
        row("Painted Cells", '<span style="color:#8a93a0;font-size:11px;">' + cellCount + "</span>") +
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        'Select the Tile tool (T) in the toolbar, then click or drag in the Scene view to paint. The tile shown at each cell auto-updates from its neighbors, like Unity\'s Rule Tile.' +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Tilemap" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const shadowCaster = entity.getComponent(SHADOW_CASTER);
  if (shadowCaster) {
    body += section(
      editorState.sectionsOpen,
      "shadowcaster",
      "Shadow Caster",
      "box",
      row(
        "Cast Shadow",
        '<input type="checkbox" data-field="ShadowCaster.enabled" style="accent-color:#2C5D87;margin:0;"' +
          (shadowCaster.enabled ? " checked" : "") +
          "/>"
      ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "When enabled, this object blocks light and casts a dynamic shadow for every nearby light that has Cast Shadows on. By default the shadow's shape matches this object's own sprite." +
        "</div>" +
        row(
          "Size Override",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("W", shadowCaster.width == null ? "" : shadowCaster.width, "ShadowCaster.width") +
            numInput("H", shadowCaster.height == null ? "" : shadowCaster.height, "ShadowCaster.height") +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Leave blank to use this object's real sprite size." +
        "</div>" +
        row(
          "Offset",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", shadowCaster.offsetX, "ShadowCaster.offsetX") +
            numInput("Y", shadowCaster.offsetY, "ShadowCaster.offsetY") +
            "</div>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Shifts where the shadow shape is centered relative to this object (rotates together with it) — e.g. anchor a shadow to a character's feet instead of its middle." +
        "</div>" +
        row("Opacity", numInput("", shadowCaster.opacity, "ShadowCaster.opacity")) +
        row("Length", numInput("", shadowCaster.length, "ShadowCaster.length")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Length is a multiplier on how far this object's shadow reaches: 1 = matches the light's own reach, 0.5 = a short shadow, 2+ = a long, late-day-sun-style shadow." +
        "</div>" +
        row("Softness", numInput("", shadowCaster.softness, "ShadowCaster.softness")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "0 = crisp hard-edged shadow. Higher values add a soft, blurred edge (penumbra) for a more realistic look." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="ShadowCaster" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const lightingSettings = entity.getComponent(LIGHTING_SETTINGS);
  if (lightingSettings) {
    body += section(
      editorState.sectionsOpen,
      "lightingsettings",
      "Lighting Settings",
      "settings",
      '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Scene-wide realism settings for every light and shadow in this scene — not tied to any one Light." +
        "</div>" +
        row("Shadow Mode", dropdownInput(Object.values(ShadowMode), lightingSettings.shadowMode, "LightingSettings.shadowMode")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "Quad: cheap analytic shadows, best for lower-end machines. Raymarch: true per-pixel shadows with realistic soft edges, costs more GPU time." +
        "</div>" +
        (lightingSettings.shadowMode === ShadowMode.RAYMARCH
          ? row("Raymarch Steps", numInput("", lightingSettings.raymarchSteps, "LightingSettings.raymarchSteps")) +
            '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
            "Higher = smoother, more accurate shadow edges (fewer thin shadows 'leaking' light through), at a higher GPU cost. 24 is a good starting point; try lower values first if this looks too slow." +
            "</div>"
          : "") +
        row("Ambient Darkness", numInput("", lightingSettings.ambientDarkness, "LightingSettings.ambientDarkness")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "How dark areas with no light get, from 0 (no darkening, full brightness everywhere) to 1 (pitch black outside any light's reach). This is the biggest single dial for how moody/realistic the scene's lighting feels." +
        "</div>" +
        row("Glow Strength", numInput("", lightingSettings.glowStrength, "LightingSettings.glowStrength")) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "How visibly lights glow in open air — over empty background, not just where they land on a sprite. 0 = lights are only visible through what they light up; 1 = a normal visible glow; higher = a brighter, hotter-looking light source." +
        "</div>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="LightingSettings" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const spriteAnimation = entity.getComponent(SPRITE_ANIMATION);
  if (spriteAnimation) {
    const currentClip = spriteAnimation.clips.find((c) => c.id === spriteAnimation.currentClipId) || null;
    const clipOptions = spriteAnimation.clips.map((c) => c.name);

    let overrideHtml = "";
    if (currentClip) {
      const ov = currentClip.colliderOverride;
      overrideHtml =
        row(
          "Collider Override",
          '<input type="checkbox" data-action="toggle-clip-collider-override" data-clip-id="' +
            currentClip.id +
            '" style="accent-color:#2C5D87;margin:0;"' +
            (ov ? " checked" : "") +
            "/>"
        ) +
        '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
        "When on, THIS clip uses its own collision shape while playing — other clips (or turning this off) leave the entity's main Collider2D shape above untouched." +
        "</div>";

      if (ov) {
        overrideHtml +=
          row(
            "Shape",
            dropdownInput(Object.values(ColliderShape), ov.shape, "SpriteAnimation.clipOverride." + currentClip.id + ".shape")
          ) +
          (ov.shape === ColliderShape.CIRCLE
            ? row("Radius", numInput("", ov.radius, "SpriteAnimation.clipOverride." + currentClip.id + ".radius"))
            : ov.shape === ColliderShape.CAPSULE
            ? row(
                "Size",
                '<div style="display:flex;gap:4px;width:100%;">' +
                  numInput("Half H", ov.capsuleHalfHeight, "SpriteAnimation.clipOverride." + currentClip.id + ".capsuleHalfHeight") +
                  numInput("Radius", ov.capsuleRadius, "SpriteAnimation.clipOverride." + currentClip.id + ".capsuleRadius") +
                  "</div>"
              )
            : ov.shape === ColliderShape.TRIANGLE
            ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
              "Open this clip in the Animation panel to edit its triangle points."
              + "</div>"
            : row(
                "Size",
                '<div style="display:flex;gap:4px;width:100%;">' +
                  numInput("W", ov.width, "SpriteAnimation.clipOverride." + currentClip.id + ".width") +
                  numInput("H", ov.height, "SpriteAnimation.clipOverride." + currentClip.id + ".height") +
                  "</div>"
              ));
      }
    }

    body += section(
      editorState.sectionsOpen,
      "spriteanimation",
      "Sprite Animation",
      "film",
      (spriteAnimation.clips.length
        ? row("Clip", dropdownInput(clipOptions, currentClip ? currentClip.name : "", "SpriteAnimation.currentClipName")) +
          row(
            "Speed",
            numInput("", spriteAnimation.speed, "SpriteAnimation.speed")
          ) +
          overrideHtml
        : '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
          "No clips yet — open the Animation panel to import frames and create one." +
          "</div>") +
        '<button class="anim-open-btn" data-action="open-anim" style="margin-top:6px;width:100%;">' +
        icon("film", 12) +
        " Open Animation Editor</button>" +
        '<button class="removecomp-btn" data-action="remove-component" data-component="SpriteAnimation" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const rigidbody = entity.getComponent(RIGIDBODY_2D);
  if (rigidbody) {
    let bodyTypeFieldsHtml = "";

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      // Dynamic: fully simulated by Rapier — mass, gravity, damping,
      // and rotation-lock all meaningfully affect the body.
      bodyTypeFieldsHtml =
        row("Mass", numInput("", rigidbody.mass, "Rigidbody2D.mass")) +
        row("Gravity Scale", numInput("", rigidbody.gravityScale, "Rigidbody2D.gravityScale")) +
        row("Linear Damping", numInput("", rigidbody.linearDamping, "Rigidbody2D.linearDamping")) +
        row("Angular Damping", numInput("", rigidbody.angularDamping, "Rigidbody2D.angularDamping")) +
        row(
          "Freeze Rotation",
          '<input type="checkbox" data-field="Rigidbody2D.lockRotation" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.lockRotation ? " checked" : "") +
            "/>"
        );
    } else if (rigidbody.bodyType === BodyType.KINEMATIC) {
      // Kinematic: moved by velocity/code, not forces — mass/gravity/
      // damping don't apply to a body Rapier never applies forces to.
      bodyTypeFieldsHtml =
        row(
          "Velocity",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", rigidbody.velocityX, "Rigidbody2D.velocityX") +
            numInput("Y", rigidbody.velocityY, "Rigidbody2D.velocityY") +
            "</div>"
        ) +
        row("Angular Velocity", numInput("", rigidbody.angularVelocity, "Rigidbody2D.angularVelocity")) +
        row(
          "Freeze Rotation",
          '<input type="checkbox" data-field="Rigidbody2D.lockRotation" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.lockRotation ? " checked" : "") +
            "/>"
        );
    } else {
      // Static: never moves. No mass/gravity/damping/velocity fields —
      // it's just an immovable collider anchor, matching Unity's
      // convention of hiding these entirely for a static body.
      bodyTypeFieldsHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Static bodies never move — position is fixed in the physics simulation." +
        "</div>";
    }

    body += section(
      editorState.sectionsOpen,
      "rigidbody",
      "Rigidbody 2D",
      "refreshcw",
      row("Body Type", dropdownInput(Object.values(BodyType), rigidbody.bodyType, "Rigidbody2D.bodyType")) +
        row(
          "Simulated",
          '<input type="checkbox" data-field="Rigidbody2D.simulated" style="accent-color:#2C5D87;margin:0;"' +
            (rigidbody.simulated ? " checked" : "") +
            "/>"
        ) +
        bodyTypeFieldsHtml +
        (!entity.getComponent(COLLIDER_2D)
          ? '<div class="static-body-note" style="padding:6px 4px;color:#c0863a;font-size:11px;">⚠️ No Collider 2D — this Rigidbody will pass through everything. Add a Collider 2D so physics collisions actually work.</div>'
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Rigidbody2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const collider = entity.getComponent(COLLIDER_2D);
  if (collider) {
    const shapeFieldsHtml =
      collider.shape === ColliderShape.CIRCLE
        ? row("Radius", numInput("", collider.radius, "Collider2D.radius"))
        : collider.shape === ColliderShape.CAPSULE
        ? row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("Half H", collider.capsuleHalfHeight, "Collider2D.capsuleHalfHeight") +
              numInput("Radius", collider.capsuleRadius, "Collider2D.capsuleRadius") +
              "</div>"
          )
        : collider.shape === ColliderShape.TRIANGLE
        ? row(
            "Points",
            '<div style="color:#888;font-size:11px;line-height:1.4;">Drag the 3 yellow handles ' +
              "directly in the Scene view to reshape.</div>"
          )
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", collider.width, "Collider2D.width") +
              numInput("H", collider.height, "Collider2D.height") +
              "</div>"
          );

    body += section(
      editorState.sectionsOpen,
      "collider",
      "Collider 2D",
      "box",
      row("Shape", dropdownInput(Object.values(ColliderShape), collider.shape, "Collider2D.shape")) +
        shapeFieldsHtml +
        row(
          "Offset",
          '<div style="display:flex;gap:4px;width:100%;">' +
            numInput("X", collider.offsetX, "Collider2D.offsetX") +
            numInput("Y", collider.offsetY, "Collider2D.offsetY") +
            "</div>"
        ) +
        row(
          "Is Trigger",
          '<input type="checkbox" data-field="Collider2D.isTrigger" style="accent-color:#2C5D87;margin:0;"' +
            (collider.isTrigger ? " checked" : "") +
            "/>"
        ) +
        row("Friction", numInput("", collider.friction, "Collider2D.friction")) +
        row("Restitution", numInput("", collider.restitution, "Collider2D.restitution")) +
        row("Density", numInput("", collider.density, "Collider2D.density")) +
        '<button class="removecomp-btn" data-action="remove-component" data-component="Collider2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const controller = entity.getComponent(CHARACTER_CONTROLLER);
  if (controller) {
    const isPlatformer = controller.controllerType === ControllerType.PLATFORMER;
    const isFree = controller.controllerType === ControllerType.FREE;
    const isCharacter = controller.controllerType === ControllerType.CHARACTER;
    const isCar = controller.controllerType === ControllerType.CAR;
    const isFollow = controller.controllerType === ControllerType.FOLLOW;
    const jumpCapable = (isCharacter || isPlatformer) && controller.canJump;

    let typeSpecificHtml = "";
    if (isFree) {
      typeSpecificHtml =
        '<div class="static-body-note" style="padding:6px 4px;color:#8a93a0;font-size:11px;">' +
        "Free: no built-in input mapping. A script drives Rigidbody2D directly; the tunables below are still readable from script." +
        "</div>";
    } else if (isCar) {
      typeSpecificHtml =
        row("Max Speed", numInput("", controller.maxSpeed, "CharacterController.maxSpeed")) +
        row("Acceleration", numInput("", controller.carAcceleration, "CharacterController.carAcceleration")) +
        row("Brake Force", numInput("", controller.brakeForce, "CharacterController.brakeForce")) +
        row("Turn Speed", numInput("", controller.turnSpeed, "CharacterController.turnSpeed")) +
        row("Drift Factor", numInput("", controller.driftFactor, "CharacterController.driftFactor"));
    } else if (isFollow) {
      typeSpecificHtml =
        row("Target Name", '<input type="text" data-field="CharacterController.targetName" value="' + (controller.targetName || "") + '" style="width:100%;background:#2a2a2a;border:1px solid #3a3a3a;color:#dcdcdc;padding:3px 6px;border-radius:3px;font-size:11px;"/>') +
        row("Follow Speed", numInput("", controller.followSpeed, "CharacterController.followSpeed")) +
        row("Follow Distance", numInput("", controller.followDistance, "CharacterController.followDistance"));
    } else {
      typeSpecificHtml =
        row("Move Speed", numInput("", controller.moveSpeed, "CharacterController.moveSpeed")) +
        row("Acceleration", numInput("", controller.acceleration, "CharacterController.acceleration"));

      if (isPlatformer) {
        typeSpecificHtml += row("Air Control", numInput("", controller.airControl, "CharacterController.airControl"));
      }

      if (isCharacter) {
        typeSpecificHtml += row(
          "Use Gravity",
          '<input type="checkbox" data-field="CharacterController.useGravity" style="accent-color:#2C5D87;margin:0;"' +
            (controller.useGravity ? " checked" : "") +
            "/>"
        );
      }

      if (isCharacter || isPlatformer) {
        typeSpecificHtml +=
          row(
            "Can Jump",
            '<input type="checkbox" data-field="CharacterController.canJump" style="accent-color:#2C5D87;margin:0;"' +
              (controller.canJump ? " checked" : "") +
              "/>"
          ) +
          (jumpCapable
            ? row("Jump Force", numInput("", controller.jumpForce, "CharacterController.jumpForce")) +
              row("Max Jumps", numInput("", controller.maxJumps, "CharacterController.maxJumps"))
            : "");
      }
    }

    body += section(
      editorState.sectionsOpen,
      "movement",
      "Movement Type",
      "move",
      row("Controller Type", dropdownInput(Object.values(ControllerType), controller.controllerType, "CharacterController.controllerType")) +
        row(
          "Use Default Input",
          '<input type="checkbox" data-field="CharacterController.useDefaultInput" style="accent-color:#2C5D87;margin:0;"' +
            (controller.useDefaultInput ? " checked" : "") +
            "/>"
        ) +
        typeSpecificHtml +
        (rigidbody && rigidbody.bodyType === BodyType.STATIC
          ? '<div class="static-body-note" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
            "This entity's Rigidbody2D Body Type is Static — a Static body never moves. Set Body Type to Dynamic (recommended — gets real collision push-back/landing from Rapier) or Kinematic above for this movement type to take effect." +
            "</div>"
          : !rigidbody
          ? '<div class="static-body-note" style="padding:6px 4px;color:#c0863a;font-size:11px;">' +
            "Add a Rigidbody2D for this movement type to actually move the object — Dynamic is recommended for the most realistic collision response (pushback, landing on slopes), or use Kinematic for a controller that ignores physics forces. Physics itself is still handled entirely by Rapier either way." +
            "</div>"
          : "") +
        '<button class="removecomp-btn" data-action="remove-component" data-component="CharacterController" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const script = entity.getComponent(SCRIPT);
  if (script) {
    body += section(
      editorState.sectionsOpen,
      "script",
      "Script",
      "code",
      row("Script Name", '<input type="text" class="num-input" value="' + script.scriptName + '" data-field="Script.scriptName" style="width:100%;box-sizing:border-box;" />') +
      row("Enabled", '<input type="checkbox"' + (script.enabled ? " checked" : "") + ' data-action="toggle-script-enabled" />') +
      '<div style="padding:6px 0;">' +
      '<button class="animwin-btn" data-action="open-script-editor" style="width:100%;">' + icon("code", 12) + " Open Script Editor</button>" +
      "</div>" +
      '<button class="removecomp-btn" data-action="remove-component" data-component="Script" style="margin-top:6px;">Remove Component</button>'
    );
  } else {
    const existingScripts = getAllScripts();
    body += section(
      editorState.sectionsOpen,
      "script",
      "Script",
      "code",
      '<div style="padding:6px 0;">' +
      '<button class="animwin-btn" data-action="inspector-create-script" style="width:100%;">' + icon("plus", 12) + " Create New Script</button>" +
      "</div>" +
      '<div style="font-size:11px;color:#8a93a0;margin:4px 0 6px;">Or load an existing script:</div>' +
      (existingScripts.length
        ? '<div style="max-height:170px;overflow-y:auto;border:1px solid #3c3c3c;border-radius:4px;background:#1e1e1e;">' +
          existingScripts
            .map(function (name) {
              return '<div data-action="inspector-load-script" data-script="' + name + '" title="Attach ' + name + '" style="display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;font-size:12px;color:#ccc;border-bottom:1px solid #2d2d2d;">' +
                icon("code", 11) + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + "</span></div>";
            })
            .join("") +
          "</div>"
        : '<div style="font-size:12px;color:#8a93a0;">No scripts created yet.</div>')
    );
  }

  const availableToAdd = [
    !rigidbody && { name: "Rigidbody2D", label: "Rigidbody 2D" },
    !collider && { name: "Collider2D", label: "Collider 2D" },
    !controller && { name: "CharacterController", label: "Movement Type" },
    !spriteAnimation && { name: "SpriteAnimation", label: "Sprite Animation" },
    !light && { name: "Light", label: "Light" },
    !audioSource && { name: "AudioSource", label: "Audio Source" },
    !shadowCaster && { name: "ShadowCaster", label: "Shadow Caster" },
    !lightingSettings && { name: "LightingSettings", label: "Lighting Settings" },
    !tileset && { name: "Tileset", label: "Tileset" },
    !tilemap && { name: "Tilemap", label: "Tilemap" },
  ].filter(Boolean);

  body +=
    '<div class="addcomp-wrap" style="position:relative;">' +
    '<button class="addcomp-btn" data-action="add-component">Add Component</button>' +
    (editorState.addComponentMenuOpen
      ? '<div class="addcomp-menu" style="position:absolute;bottom:100%;left:0;right:0;background:#2a2f36;border:1px solid #444;border-radius:4px;margin-bottom:4px;overflow:hidden;z-index:20;">' +
        (availableToAdd.length
          ? availableToAdd
              .map(
                (c) =>
                  '<button class="addcomp-menu-item" data-action="add-component-choice" data-component="' +
                  c.name +
                  '" style="display:block;width:100%;text-align:left;padding:8px 10px;background:none;border:none;color:#ddd;cursor:pointer;font-size:12px;">' +
                  c.label +
                  "</button>"
              )
              .join("")
          : '<div style="padding:8px 10px;color:#8a93a0;font-size:11px;">All available components added</div>') +
        "</div>"
      : "") +
    "</div>";
  body +=
    '<div class="animwin-wrap"><button class="animwin-btn" data-action="open-anim">' +
    icon("film", 12) +
    " Open Animation Window</button></div>";

  return (
    '<div class="inspector-panel">' +
    '<div class="inspector-tabbar">' +
    tabBtn(true, "Inspector", "info") +
    '<button class="more">' +
    icon("morevertical", 12) +
    "</button></div>" +
    '<div class="inspector-body">' +
    '<div class="obj-header">' +
    '<div class="obj-header-row1">' +
    '<input type="checkbox"' +
    (entity.active ? " checked" : "") +
    ' data-action="toggle-entity-active" />' +
    '<input type="text" class="obj-name-input" value="' +
    entity.name +
    '" data-action="rename-entity" />' +
    '<div class="static-box"><input type="checkbox" /><span>Static</span>' +
    icon("chevrondown", 10) +
    "</div>" +
    "</div>" +
    '<div class="obj-header-row2">' +
    '<div class="tag-layer-group"><span>Tag</span>' +
    dropdownInput([entity.tag, "Untagged", "Player", "Enemy", "Add Tag..."], entity.tag, "entity.tag") +
    "</div>" +
    '<div class="tag-layer-group"><span class="layer-label">Layer</span>' +
    dropdownInput(["Default", "TransparentFX", "Ignore Raycast", "Water", "UI", "Add Layer..."]) +
    "</div>" +
    "</div>" +
    "</div>" +
    body +
    "</div>" +
    "</div>"
  );
}

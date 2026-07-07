/**
 * editor/panels/AnimationWindow.js
 *
 * Frame-based Animation panel (Unity 2D "Sprite Editor" / simple
 * frame-list animator style) — NOT a keyframe/property timeline. Lets
 * the user:
 *   - create/rename/delete animation clips on the selected entity's
 *     SpriteAnimation component (see runtime/components/SpriteAnimation.js)
 *   - import frames from standalone images, a .zip of images, or a
 *     single sprite-sheet (auto-detected or a manual grid override)
 *     via editor/animation/AnimationImport.js
 *   - drag frame thumbnails to reorder them, or delete individual frames
 *   - preview the clip (play/pause/step) independent of game playback
 *   - set the clip's fps and loop flag
 *   - toggle a per-clip collider shape override (mirrors the same
 *     fields as the Inspector's own Collider2D section -- see
 *     editor/panels/Inspector.js's "Sprite Animation" section, which
 *     edits the exact same clip.colliderOverride data this panel does)
 *
 * All actual data lives on the selected entity's live SpriteAnimation
 * component (editorState.world) -- this file only reads/writes that
 * component's plain fields plus its own small bit of editor-only UI
 * state in editorState.anim (see EditorState.js) for things like which
 * frame is being previewed/dragged, matching every other panel's
 * convention of keeping data in the runtime and UI-only state in
 * editorState.
 *
 * EDITOR-ONLY FILE.
 */

import { icon } from "../icons/IconLibrary.js";
import { dropdownInput, row, numInput } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { SPRITE_ANIMATION, generateClipId } from "../../runtime/components/SpriteAnimation.js";
import { ColliderShape } from "../../runtime/components/Collider2D.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

/** Resolves a frame's thumbnail dataUrl by spriteKey via the shared
 * asset catalogue -- see AssetRegistry.registerSpriteAsset(), which
 * AnimationImport.js calls for every frame it produces regardless of
 * which of the 3 import paths created it. */
function _thumbFor(spriteKey) {
  const asset = getSpriteAsset(spriteKey);
  return asset ? asset.dataUrl : null;
}

export function renderAnimEditor() {
  if (!editorState.animOpen) return "";

  const world = editorState.world;
  const entity = world ? world.getEntity(editorState.selectedId) : null;
  const anim = entity ? entity.getComponent(SPRITE_ANIMATION) : null;

  return (
    '<div class="anim-overlay">' +
    '<div class="anim-backdrop" data-action="close-anim"></div>' +
    '<div class="anim-window animpanel-window">' +
    '<div class="anim-header"><div class="title">' +
    icon("film", 12) +
    ' Animation</div><button class="anim-close" data-action="close-anim">' +
    icon("x", 12) +
    "</button></div>" +
    (entity ? (anim ? _renderBody(entity, anim) : _renderNoComponent()) : _renderNoSelection()) +
    "</div>" +
    "</div>"
  );
}

function _renderNoSelection() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>Select an entity in the Scene to edit its animations.</p>" +
    "</div>"
  );
}

function _renderNoComponent() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>This entity has no Sprite Animation component yet.</p>" +
    '<button class="anim-open-btn" data-action="add-component-choice" data-component="SpriteAnimation">' +
    icon("plus", 12) +
    " Add Sprite Animation</button>" +
    "</div>"
  );
}

function _renderBody(entity, anim) {
  const clip = anim.clips.find((c) => c.id === editorState.anim.editingClipId) || anim.clips[0] || null;
  if (clip && editorState.anim.editingClipId !== clip.id) {
    editorState.anim.editingClipId = clip.id;
  }

  return (
    '<div class="animpanel-toolbar">' +
    _renderClipPicker(anim, clip) +
    '<button class="animpanel-ibtn" data-action="anim-new-clip" title="New Clip">' + icon("plus", 13) + "</button>" +
    (clip
      ? '<button class="animpanel-ibtn" data-action="anim-rename-clip" data-clip-id="' +
        clip.id +
        '" title="Rename Clip">' +
        icon("morevertical", 13) +
        "</button>" +
        '<button class="animpanel-ibtn danger" data-action="anim-delete-clip" data-clip-id="' +
        clip.id +
        '" title="Delete Clip">' +
        icon("trash", 13) +
        "</button>"
      : "") +
    "</div>" +
    (clip ? _renderClipEditor(entity, anim, clip) : _renderNoClips())
  );
}

function _renderNoClips() {
  return (
    '<div class="animpanel-empty">' +
    icon("film", 28) +
    "<p>No animation clips yet.</p>" +
    '<button class="anim-open-btn" data-action="anim-new-clip">' + icon("plus", 12) + " Create Animation</button>" +
    "</div>"
  );
}

function _renderClipPicker(anim, clip) {
  if (editorState.anim.renamingClipId === (clip && clip.id)) {
    return (
      '<input class="animpanel-rename-input" type="text" value="' +
      _escapeAttr(clip.name) +
      '" data-action="anim-rename-clip-input" data-clip-id="' +
      clip.id +
      '" autofocus />'
    );
  }
  if (anim.clips.length === 0) return '<div class="animpanel-clip-picker-empty">No clips</div>';
  return (
    '<div class="animpanel-clip-picker">' +
    dropdownInput(
      anim.clips.map((c) => c.name),
      clip ? clip.name : "",
      "SpriteAnimation.editingClipName"
    ) +
    "</div>"
  );
}

function _renderClipEditor(entity, anim, clip) {
  const frameCount = clip.frames.length;
  const previewIndex = Math.min(editorState.anim.previewFrameIndex, Math.max(0, frameCount - 1));
  const previewFrame = clip.frames[previewIndex];
  const previewThumb = previewFrame ? _thumbFor(previewFrame.spriteKey) : null;

  return (
    '<div class="animpanel-body">' +
    '<div class="animpanel-preview-col">' +
    '<div class="animpanel-preview">' +
    (previewThumb
      ? '<img src="' + previewThumb + '" alt="" />'
      : '<div class="animpanel-preview-empty">' + icon("film", 32) + "<span>No frames</span></div>") +
    "</div>" +
    '<div class="animpanel-transport">' +
    '<button class="animpanel-ibtn" data-action="anim-preview-step" data-dir="-1" title="Previous Frame">' +
    icon("stepforward", 13, "flip") +
    "</button>" +
    '<button class="animpanel-ibtn animpanel-play" data-action="anim-preview-toggle-play" title="Play/Pause Preview">' +
    icon(editorState.anim.previewPlaying ? "pause" : "play", 14) +
    "</button>" +
    '<button class="animpanel-ibtn" data-action="anim-preview-step" data-dir="1" title="Next Frame">' +
    icon("stepforward", 13) +
    "</button>" +
    '<span class="animpanel-frame-counter">' +
    (frameCount ? previewIndex + 1 + " / " + frameCount : "0 / 0") +
    "</span>" +
    "</div>" +
    '<div class="animpanel-clip-settings">' +
    row("FPS", numInput("", clip.fps, "SpriteAnimation.clipFps." + clip.id)) +
    row(
      "Loop",
      '<input type="checkbox" data-action="anim-toggle-loop"' + (clip.loop ? " checked" : "") + ' style="accent-color:#2C5D87;margin:0;" />'
    ) +
    "</div>" +
    _renderColliderOverrideSection(clip) +
    "</div>" +
    '<div class="animpanel-frames-col">' +
    '<div class="animpanel-frames-head">' +
    "<span>Frames (" + frameCount + ")</span>" +
    '<div class="animpanel-import-btns">' +
    '<label class="animpanel-import-btn" title="Import standalone images">' +
    icon("upload", 12) +
    " Images" +
    '<input type="file" accept="image/*" multiple style="display:none;" data-action="anim-import-images" />' +
    "</label>" +
    '<label class="animpanel-import-btn" title="Import a .zip full of images">' +
    icon("upload", 12) +
    " Zip" +
    '<input type="file" accept=".zip" style="display:none;" data-action="anim-import-zip" />' +
    "</label>" +
    '<label class="animpanel-import-btn" title="Slice a single sprite sheet into frames">' +
    icon("grid", 12) +
    " Sheet" +
    '<input type="file" accept="image/*" style="display:none;" data-action="anim-import-sheet" />' +
    "</label>" +
    "</div>" +
    "</div>" +
    '<div class="animpanel-frame-grid">' +
    (frameCount
      ? clip.frames
          .map((frame, i) => _renderFrameThumb(frame, i, previewIndex))
          .join("")
      : '<div class="animpanel-frames-empty">Import images, a zip, or a sprite sheet above to add frames.</div>') +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

function _renderFrameThumb(frame, index, previewIndex) {
  const thumb = _thumbFor(frame.spriteKey);
  const isDragging = editorState.anim.draggingFrameIndex === index;
  return (
    '<div class="animpanel-frame' +
    (index === previewIndex ? " active" : "") +
    (isDragging ? " dragging" : "") +
    '" draggable="true" data-action="anim-frame-thumb" data-frame-index="' +
    index +
    '">' +
    (thumb ? '<img src="' + thumb + '" alt="" draggable="false" />' : '<div class="animpanel-frame-missing">?</div>') +
    '<span class="animpanel-frame-num">' + (index + 1) + "</span>" +
    '<button class="animpanel-frame-del" data-action="anim-delete-frame" data-frame-index="' +
    index +
    '" title="Delete frame">' +
    icon("x", 10) +
    "</button>" +
    "</div>"
  );
}

function _renderColliderOverrideSection(clip) {
  const ov = clip.colliderOverride;
  const f = (prop) => "SpriteAnimation.clipOverride." + clip.id + "." + prop;
  let shapeFieldsHtml = "";
  if (ov) {
    shapeFieldsHtml =
      row("Shape", dropdownInput(Object.values(ColliderShape), ov.shape, f("shape"))) +
      (ov.shape === ColliderShape.CIRCLE
        ? row("Radius", numInput("", ov.radius, f("radius")))
        : ov.shape === ColliderShape.CAPSULE
        ? row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("Half H", ov.capsuleHalfHeight, f("capsuleHalfHeight")) +
              numInput("Radius", ov.capsuleRadius, f("capsuleRadius")) +
              "</div>"
          )
        : ov.shape === ColliderShape.TRIANGLE
        ? '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
          "Select this entity and pick this clip from the Inspector to drag its 3 points in the Scene view." +
          "</div>"
        : row(
            "Size",
            '<div style="display:flex;gap:4px;width:100%;">' +
              numInput("W", ov.width, f("width")) +
              numInput("H", ov.height, f("height")) +
              "</div>"
          ));
  }

  return (
    '<div class="animpanel-collider-override">' +
    row(
      "Collider Override",
      '<input type="checkbox" data-action="anim-toggle-collider-override"' +
        (ov ? " checked" : "") +
        ' style="accent-color:#2C5D87;margin:0;"/>'
    ) +
    '<div class="static-body-note" style="padding:2px 0 6px;color:#8a93a0;font-size:10px;">' +
    "When on, this clip uses its own collision shape while playing." +
    "</div>" +
    shapeFieldsHtml +
    "</div>"
  );
}

function _escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Creates a fresh, empty clip and returns it -- exported so
 * EditorEvents.js's "anim-new-clip" action can create the clip without
 * duplicating the id-generation/default-fields logic here. */
export function createEmptyClip(existingNames) {
  let name = "New Animation";
  let n = 1;
  const taken = new Set(existingNames);
  while (taken.has(name)) {
    n++;
    name = "New Animation " + n;
  }
  return {
    id: generateClipId(),
    name,
    frames: [],
    fps: 12,
    loop: true,
    colliderOverride: null,
  };
}

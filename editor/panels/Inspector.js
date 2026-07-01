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
import { getCameraResolution } from "../../runtime/core/CameraUtils.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

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
        row("Background", '<div class="color-swatch" style="background:' + camera.backgroundColor + ';" data-action="pick-color" data-field="Camera.backgroundColor"></div>') +
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
        resolution.width + " x " + resolution.height + " px</span></div></div>"
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
        row("Color", '<div class="color-swatch" style="background:' + spriteRenderer.color + ';" data-action="pick-color" data-field="SpriteRenderer.color"></div>') +
        row(
          "Flip",
          '<div class="flip-row"><label><input type="checkbox" data-field="SpriteRenderer.flipX"' +
            (spriteRenderer.flipX ? " checked" : "") +
            "/> X</label><label><input type=\"checkbox\" data-field=\"SpriteRenderer.flipY\"" +
            (spriteRenderer.flipY ? " checked" : "") +
            "/> Y</label></div>"
        ) +
        row("Order in Layer", numInput("", spriteRenderer.orderInLayer, "SpriteRenderer.orderInLayer"))
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
        '<button class="removecomp-btn" data-action="remove-component" data-component="Rigidbody2D" style="margin-top:6px;">Remove Component</button>'
    );
  }

  const collider = entity.getComponent(COLLIDER_2D);
  if (collider) {
    const shapeFieldsHtml =
      collider.shape === ColliderShape.CIRCLE
        ? row("Radius", numInput("", collider.radius, "Collider2D.radius"))
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

  const availableToAdd = [
    !rigidbody && { name: "Rigidbody2D", label: "Rigidbody 2D" },
    !collider && { name: "Collider2D", label: "Collider 2D" },
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

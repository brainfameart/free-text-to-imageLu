/**
 * runtime/components/Camera.js
 *
 * Marks an entity as a camera and holds its viewport settings. A scene
 * is expected to have exactly one Main Camera (enforced by SceneLoader).
 *
 * `aspectMode` decides what shape the exported/played game screen is:
 *  - "Landscape"  : uses landscapeWidth x landscapeHeight
 *  - "Portrait"   : uses portraitWidth x portraitHeight
 *  - "Square"     : 1:1, driven by squareSize
 *  - "Custom"     : uses customWidth x customHeight verbatim
 * These pixel dimensions are the exact resolution the game is played /
 * exported at — see runtime/core/CameraUtils.js for the shared math both
 * the editor gizmo and the play window use to stay in sync.
 *
 * `enablePseudo3D` is a scene-wide depth toggle: when true, every
 * sprite's Transform.z ALSO scales its rendered size (more negative z =
 * farther from camera = smaller), giving a cheap fake-parallax/3D look,
 * on top of z always controlling draw order. When false (default), z
 * only controls draw order and never touches an object's visual size —
 * see runtime/systems/RenderSystem.js for where this is applied.
 *
 * RUNTIME-ONLY FILE.
 */

export const CAMERA = "Camera";

export const CameraAspectMode = Object.freeze({
  LANDSCAPE: "Landscape",
  PORTRAIT: "Portrait",
  SQUARE: "Square",
  CUSTOM: "Custom",
});

export class Camera {
  constructor({
    backgroundColor = "#314D79",
    projection = "Orthographic",
    size = 5,
    nearClip = 0.3,
    farClip = 1000,
    isMain = false,
    aspectMode = CameraAspectMode.LANDSCAPE,
    landscapeWidth = 960,
    landscapeHeight = 540,
    portraitWidth = 540,
    portraitHeight = 960,
    squareSize = 720,
    customWidth = 800,
    customHeight = 600,
    enablePseudo3D = false,
    renderToSpriteEntityId = null,
  } = {}) {
    this.backgroundColor = backgroundColor;
    this.projection = projection;
    this.size = size;
    this.nearClip = nearClip;
    this.farClip = farClip;
    this.isMain = isMain;

    this.aspectMode = aspectMode;
    this.landscapeWidth = landscapeWidth;
    this.landscapeHeight = landscapeHeight;
    this.portraitWidth = portraitWidth;
    this.portraitHeight = portraitHeight;
    this.squareSize = squareSize;
    this.customWidth = customWidth;
    this.customHeight = customHeight;
    this.enablePseudo3D = enablePseudo3D;

    // When set (via this.camera.renderToSprite(spriteEntity) in a script),
    // CameraRenderSystem renders THIS camera's view into a RenderTexture
    // every frame and assigns it as the target sprite's texture — the
    // standard minimap / security-camera technique. null = no render-to-
    // texture (the camera only drives the main screen, if it's the Main
    // Camera). The value is the target entity's id (not its name) so it
    // survives renames. See runtime/systems/CameraRenderSystem.js.
    this.renderToSpriteEntityId = renderToSpriteEntityId;
  }
}

# ZenEngine — Controller & Physics Fixes

Summary of bugs found and fixed in this pass. All changes stay inside
`/runtime` (no `/editor` imports added — see RULES.txt section 1).

---

## 1. Kinematic character stuck to the ceiling after jumping
**File:** `runtime/systems/ControllerSystem.js` (`_applyKinematic`)

The kinematic path hand-rolls its own vertical velocity (`vy`) for
gravity/jumping. It only ever reset `vy` when `rigidbody.grounded` was
true — it never checked `rigidbody.isOnCeiling` (which
`PhysicsWorld.js` already computes correctly every step from the real
sweep). Result: after a jump hit a ceiling, the sweep correctly
*blocked* the movement, but `vy` stayed large and negative (still
"trying" to move up) every subsequent frame, so the character sat
pinned flush against the ceiling instead of falling back down.

**Fix:** `vy` is now zeroed the instant `isOnCeiling` is true, so
gravity retakes over immediately — same pattern already used for
landing on the ground.

---

## 2. `airControl` was defined everywhere but never actually applied
**File:** `runtime/systems/ControllerSystem.js` (`_applyKinematic` and `_applyDynamic`)

`CharacterController.airControl` is documented, wired into the
Inspector's "Air Control" slider, and exposed via
`this.controller.airControl` — but `ControllerSystem` itself never
read it. Every controller accelerated at full ground acceleration in
mid-air regardless of the slider's value, so "less control in the air"
never actually happened.

**Fix:** both the Kinematic and Dynamic paths now multiply the
horizontal acceleration lerp by `airControl` whenever the body isn't
grounded.

---

## 3. Dynamic-body push ("bulldozer") ignored mass ratio entirely
**File:** `runtime/physics/PhysicsWorld.js` (`_pushDynamicBodies`)

This is the "all mass-ratio cases yield identical velocities" bug.
The push impulse was computed as `impulse = otherMass * (kinematicSpeed
- currentVelocityAlongTravel)` — i.e. it forced *every* hit body to
exactly the kinematic's own travel speed in a single physics step. The
kinematic's own configured mass (`rb.mass`, already fed into
`setCharacterMass` elsewhere in the same file) never entered the
formula. A 1-mass crate and a 1000-mass boulder both got shoved to
identical velocity by the same push.

**Fix:** the per-step velocity transfer is now scaled by the
pusher-to-pushed mass ratio, `pusherMass / (pusherMass + otherMass)` —
the same weighted-average shape a real inelastic contact resolves to.
A much-heavier pusher still shoves light obstacles to full speed
almost immediately (old behavior preserved for that case); a
lighter-or-comparable pusher now only transfers a fraction of its
speed per step, so heavy bodies visibly lag and ramp up over several
frames instead of snapping instantly, and very heavy obstacles barely
move at all per push — like a real bulldozer with finite mass/power
instead of an unstoppable wall.

---

## 4. `groundAngle` (the live computed angle) was never exposed to scripts
**Files:** `runtime/scripting/components/RigidbodyAPI.js`,
`runtime/scripting/components/ControllerAPI.js`

`this.rigidbody.groundAngleLimit` / `wallAngleLimit` / `slopeMinAngle`
(the configurable *thresholds*) were exposed to scripts, but the
actual *live, per-frame* `groundAngle` value the engine computes every
step (`Rigidbody2D.groundAngle`) had no script-facing getter at all —
there was no way to ask "what's the actual angle of the surface I'm
standing on right now."

Separately, `isOnCeiling` / `isOnWall` / `isOnSlope` / `groundAngle`
only existed on `this.rigidbody`, not on `this.controller` — a script
driving movement through `this.controller` had to also reach into
`this.rigidbody` just to check contact state.

**Fix:**
- Added `this.rigidbody.groundAngle` (read-only getter).
- Mirrored `isOnCeiling`, `isOnWall`, `isOnSlope`, `groundAngle` onto
  `this.controller` for all three walk-family types (Character
  Controller, Platformer, Top-Down), matching what's already on
  `this.rigidbody`.

---

## 5. `input.keyPressed()` was silently broken inside `onUpdate()`
**File:** `runtime/systems/ScriptSystem.js` (`update`)

This is the "on key press trigger" bug. Per-frame lifecycle order was:

1. `onFixedUpdate` runs (possibly 0+ times)
2. **`_clearFrameKeys()` runs — wipes the one-shot `keyPressed` state**
3. `onUpdate` runs

So `input.keyPressed("Space")` (or any key) read inside `onUpdate` —
the single most commonly used per-frame callback — was **always
false**, because the "just pressed this frame" state had already been
cleared one step earlier in the same frame. Only `onFixedUpdate` ever
had a chance to observe a genuine key-press edge.

**Fix:** moved `_clearFrameKeys()` to run *after* the `onUpdate` loop
(right before the end-of-frame destroy flush), so both
`onFixedUpdate` and `onUpdate` see the same `keyPressed` state for the
entire frame the key was actually pressed on, and it's only cleared
once every lifecycle callback has had its turn.

---

## 6. Arrow keys / Space scrolled the page and could desync input state
**File:** `runtime/systems/ControllerSystem.js` (`InputState`)

Neither of the engine's two independent key trackers ever called
`preventDefault()`. In a browser this means holding an arrow key or
Space scrolls the page (taking the game canvas out of view), and Space
can "activate" whatever element currently has focus. Either one can
shift keyboard focus away from the game mid-press, which sometimes
drops the matching `keyup` event — leaving that key stuck "down"
forever in `ControllerSystem`'s tracked set, i.e. a character that
keeps walking or jumping on its own after the key was actually
released.

**Fix:** `ControllerSystem`'s `InputState` now calls
`preventDefault()`, but *only* for the specific key codes this engine
actually binds to game actions (arrows, WASD, Space) — not a blanket
block — so other browser/editor shortcuts and any text inputs
elsewhere on the page are unaffected.

---

## Also addressed (from the original request)

- **isOnWall / isOnSlope / groundAngle already existed** in
  `PhysicsWorld.js`'s sweep classification (`_syncKinematicMovement`)
  and were already correctly computed from real collision normals —
  they just weren't fully exposed to scripts (see #4) or reacted to by
  `ControllerSystem` (see #1). No new detection logic was needed;
  the classification math itself (angle-from-up via the contact
  normal, using `groundAngleLimit`/`wallAngleLimit`/`slopeMinAngle`)
  was already correct.
- **Kinematic-vs-static / kinematic-vs-kinematic sticking through
  walls** was already fixed in this codebase (see the
  `setActiveCollisionTypes` call in `PhysicsWorld._syncCollider` and
  the regression test in `player/test-collisions.js`) — verified, not
  re-touched.
- See `player/example-scripts/ContactStateDebug.js` for a drop-in
  script that `console.log`s every contact-state flag
  (`grounded`/`isOnCeiling`/`isOnWall`/`isOnSlope`/`groundAngle`) and
  shows exactly how to configure the three angle thresholds
  (`groundAngleLimit`, `wallAngleLimit`, `slopeMinAngle`).

## How to use all the "on___" states + angles together

```js
function onUpdate(dt) {
  var grounded = this.rigidbody.grounded;      // touching walkable ground/slope
  var onCeiling = this.rigidbody.isOnCeiling;   // hit something directly above
  var onWall = this.rigidbody.isOnWall;         // touching a near-vertical surface
  var onSlope = this.rigidbody.isOnSlope;       // grounded AND surface is tilted
  var angle = this.rigidbody.groundAngle;       // 0 = flat, up to groundAngleLimit

  // Configure thresholds (degrees from flat), once in onStart() is enough:
  // this.rigidbody.groundAngleLimit = 45; // <= this angle = walkable ground
  // this.rigidbody.wallAngleLimit   = 70; // >= this angle = genuine wall
  // this.rigidbody.slopeMinAngle    = 10; // >= this angle = isOnSlope true
}
```

Same four reads also work via `this.controller.isOnCeiling` /
`isOnWall` / `isOnSlope` / `groundAngle` for Character
Controller/Platformer/Top-Down types.

/**
 * player/test-collisions.js
 *
 * Automated regression test for Rigidbody2D collision pairings.
 *
 * WHY THIS FILE EXISTS: PhysicsWorld.js (runtime/physics/PhysicsWorld.js)
 * has to explicitly opt in to Rapier's non-default collision pairings
 * (Kinematic-vs-Static, Kinematic-vs-Kinematic — see its
 * setActiveCollisionTypes call). It's very easy to silently regress this
 * one line in a future refactor and not notice until a specific pairing
 * in the actual game starts clipping through walls. This test drives
 * every meaningful body-type pairing through the REAL runtime (same
 * createGame() / World / PhysicsWorld the editor and player use — no
 * mocking, no separate physics setup) so "this test passes" and "the
 * game engine behaves correctly" are guaranteed to mean the same thing.
 *
 * Imports ONLY from /runtime, same rule player/main.js follows.
 *
 * RUNTIME-ONLY FILE (loaded standalone via test-collisions.html).
 */

import { createGame } from "../runtime/index.js";
import { TRANSFORM, Transform } from "../runtime/components/Transform.js";
import { RIGIDBODY_2D, Rigidbody2D, BodyType } from "../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D, Collider2D } from "../runtime/components/Collider2D.js";

// How many fixed physics steps to run each case for before checking the
// result. Generous enough for a 400px/s mover to cross a ~250px gap
// several times over if nothing stops it, so "still on the near side of
// the wall" can only mean the wall actually blocked it, never "just
// hasn't arrived yet."
const STEPS = 180;
const DT = 1 / 60;

// Movers start at x=0 travelling at +MOVER_SPEED px/s straight toward a
// wall centered at WALL_X. A wall half-width of 20 means its near face
// sits at WALL_X - 20 = 230.
const MOVER_SPEED = 400;
const WALL_X = 250;
const WALL_HALF = 20;
const MOVER_HALF = 16;

// If the pairing correctly collides, the mover should end up resting
// with its OWN near face touching the wall's near face — i.e. its center
// should land close to (WALL_X - WALL_HALF - MOVER_HALF) and never
// exceed it by more than a small solver-slop tolerance. If it passes
// through, its center will sail past WALL_X entirely (it travels ~66x
// the gap distance over 180 steps at this speed, so "passed through"
// and "blocked" are never ambiguous).
const EXPECTED_REST_X = WALL_X - WALL_HALF - MOVER_HALF;
const SLOP = 12;

const CASES = [
  {
    id: "kinematic-vs-static",
    title: "Kinematic mover → Static wall",
    moverType: BodyType.KINEMATIC,
    wallType: BodyType.STATIC,
    note: "The exact pairing reported as passing through before the fix.",
  },
  {
    id: "kinematic-vs-kinematic",
    title: "Kinematic mover → Kinematic wall",
    moverType: BodyType.KINEMATIC,
    wallType: BodyType.KINEMATIC,
    note: "Two moving/animated bodies (e.g. player vs a moving platform/enemy).",
  },
  {
    id: "kinematic-vs-dynamic",
    title: "Kinematic mover → Dynamic wall",
    moverType: BodyType.KINEMATIC,
    wallType: BodyType.DYNAMIC,
    note: "Sanity check — this pairing already worked before the fix.",
  },
  {
    id: "dynamic-vs-static",
    title: "Dynamic mover → Static wall",
    moverType: BodyType.DYNAMIC,
    wallType: BodyType.STATIC,
    note: "Baseline sanity check — the pairing that always worked.",
  },
];

function renderCases(cases) {
  const container = document.getElementById("cases");
  container.innerHTML = "";
  for (const c of cases) {
    const div = document.createElement("div");
    div.className = "case " + c.status;
    div.innerHTML = `
      <h2>${c.title} — <span class="status ${c.status}">${c.status.toUpperCase()}</span></h2>
      <p>${c.note}</p>
      <p>${c.detail || ""}</p>
    `;
    container.appendChild(div);
  }
}

function updateSummary(cases) {
  const summary = document.getElementById("summary");
  const done = cases.filter((c) => c.status !== "pending");
  if (done.length < cases.length) {
    summary.textContent = `Running… (${done.length}/${cases.length})`;
    summary.style.color = "#999";
    return;
  }
  const failed = cases.filter((c) => c.status === "fail");
  if (failed.length === 0) {
    summary.textContent = "ALL PASS — every body-type pairing correctly collides.";
    summary.style.color = "#66bb6a";
  } else {
    summary.textContent = `${failed.length} of ${cases.length} pairing(s) FAILED — see below.`;
    summary.style.color = "#ef5350";
  }
}

/**
 * Builds one mover + one wall entity for a single test case inside the
 * given world, using the exact same components (Rigidbody2D, Collider2D)
 * a scene file or the Inspector would attach.
 */
function spawnCase(world, c) {
  const wall = world.createEntity("Wall_" + c.id, "Test");
  wall.addComponent(TRANSFORM, new Transform({ x: WALL_X, y: c.laneY }));
  wall.addComponent(
    RIGIDBODY_2D,
    new Rigidbody2D({ bodyType: c.wallType, simulated: true })
  );
  wall.addComponent(
    COLLIDER_2D,
    new Collider2D({ width: WALL_HALF * 2, height: 200 })
  );

  const mover = world.createEntity("Mover_" + c.id, "Test");
  mover.addComponent(TRANSFORM, new Transform({ x: 0, y: c.laneY }));
  const rb = new Rigidbody2D({
    bodyType: c.moverType,
    simulated: true,
    velocityX: MOVER_SPEED,
    velocityY: 0,
    gravityScale: 0,
  });
  mover.addComponent(RIGIDBODY_2D, rb);
  mover.addComponent(
    COLLIDER_2D,
    new Collider2D({ width: MOVER_HALF * 2, height: MOVER_HALF * 2 })
  );

  return { wall, mover };
}

async function run() {
  const mount = document.getElementById("game-canvas");
  const pixiApp = new PIXI.Application({
    width: mount.clientWidth || 480,
    height: mount.clientHeight || 480,
    backgroundColor: 0x1b1b1b,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true });
  const world = game.world;

  // Wipe the default starter scene's entities — this test wants a
  // known-empty world it fully controls, not whatever loadDefault()
  // ships with.
  world.clear();

  // Lay every case out on its own horizontal lane (spaced in Y) so they
  // can all run simultaneously in the SAME physics world/step, and so
  // watching the canvas actually shows every case moving at once.
  const LANE_SPACING = 60;
  CASES.forEach((c, i) => {
    c.laneY = (i - (CASES.length - 1) / 2) * LANE_SPACING;
    c.status = "pending";
  });

  const spawned = CASES.map((c) => ({ c, ...spawnCase(world, c) }));

  renderCases(CASES);
  updateSummary(CASES);

  // Wait for Rapier's WASM to finish loading before stepping — PhysicsSystem
  // silently no-ops every frame until then (see PhysicsSystem.js), so
  // stepping early would just waste frames, not produce wrong results, but
  // waiting keeps the step count meaningful.
  const physicsSystem = world.systems.find((s) => s.constructor.name === "PhysicsSystem");
  await physicsSystem.physicsWorld.whenReady();

  for (let step = 0; step < STEPS; step++) {
    world.update(DT);
  }

  // Let one more render tick flush so the canvas visually matches the
  // final simulated state, purely for the human watching the left panel.
  pixiApp.render();

  for (const { c, mover } of spawned) {
    const t = mover.getComponent(TRANSFORM);
    const passedThrough = t.x > WALL_X + WALL_HALF;
    const blockedCorrectly = Math.abs(t.x - EXPECTED_REST_X) <= SLOP;

    if (c.wallType === BodyType.STATIC && c.moverType === BodyType.DYNAMIC) {
      // Dynamic movers can settle slightly differently under gravity/solver
      // softness than a pure kinematic velocity clamp — same pass/fail
      // logic, just documented separately since this case is the baseline.
    }

    if (passedThrough) {
      c.status = "fail";
      c.detail = `Mover ended at x=${t.x.toFixed(1)} — it passed straight through the wall (wall near face is at x=${(WALL_X - WALL_HALF).toFixed(0)}).`;
    } else if (blockedCorrectly) {
      c.status = "pass";
      c.detail = `Mover correctly stopped at x=${t.x.toFixed(1)} (expected ≈${EXPECTED_REST_X.toFixed(1)}).`;
    } else {
      // Didn't pass through, but didn't settle at the expected contact
      // point either — flag it rather than silently calling it a pass,
      // since that usually means partial penetration or an unexpectedly
      // soft contact rather than a clean block.
      c.status = "fail";
      c.detail = `Mover stopped at x=${t.x.toFixed(1)}, but expected ≈${EXPECTED_REST_X.toFixed(1)} (±${SLOP}) — check for penetration/solver softness.`;
    }
  }

  renderCases(CASES);
  updateSummary(CASES);

  // Exposed for convenience if someone wants to poke at the live world
  // from the browser console after the run finishes.
  window.__zengineCollisionTest = { world, cases: CASES };
}

run();

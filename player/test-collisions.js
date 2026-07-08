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
 * Runs ONE case at a time, driven by requestAnimationFrame with REAL
 * elapsed dt (not a tight synchronous loop) so you can watch each mover
 * cross the canvas and see it stop (or not) with your own eyes, not just
 * read a final-position number. Waits 2s after boot before the first
 * case starts so Rapier's WASM has time to finish loading (whenReady()
 * is still awaited too — the 2s delay is just so the "Starting…" state
 * is visible instead of the first case appearing to freeze).
 *
 * Imports ONLY from /runtime, same rule player/main.js follows.
 *
 * RUNTIME-ONLY FILE (loaded standalone via test-collisions.html).
 */

import { createGame } from "../runtime/index.js";
import { TRANSFORM, Transform } from "../runtime/components/Transform.js";
import { RIGIDBODY_2D, Rigidbody2D, BodyType } from "../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D, Collider2D } from "../runtime/components/Collider2D.js";

// Real-time cap per case (seconds) — generous enough for a 400px/s mover
// to cross the gap and slam the wall many times over if nothing stops it
// (so "still short of the wall" can only mean "actually blocked", never
// "hasn't arrived yet").
const CASE_TIME_LIMIT = 3;

const MOVER_SPEED = 400;
const WALL_X = 250;
const WALL_HALF = 20;
const MOVER_HALF = 16;
const START_X = 0;

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
  {
    id: "kinematic-pushes-dynamic",
    title: "Kinematic mover PUSHES Dynamic box (bulldozer)",
    moverType: BodyType.KINEMATIC,
    wallType: BodyType.DYNAMIC,
    pushTest: true,
    note: "Checks the box is actually SHOVED ahead of the mover, not just left in place or merely un-collided-with.",
  },
];

const els = {
  summary: document.getElementById("summary"),
  cases: document.getElementById("cases"),
};

function renderCases() {
  els.cases.innerHTML = "";
  for (const c of CASES) {
    const div = document.createElement("div");
    div.className = "case " + c.status;
    div.innerHTML = `
      <h2>${c.title} — <span class="status ${c.status}">${c.status.toUpperCase()}</span></h2>
      <p>${c.note}</p>
      <p>${c.detail || ""}</p>
    `;
    els.cases.appendChild(div);
  }
}

function updateSummary(runningLabel) {
  if (runningLabel) {
    els.summary.textContent = runningLabel;
    els.summary.style.color = "#999";
    return;
  }
  const done = CASES.filter((c) => c.status !== "pending");
  if (done.length < CASES.length) {
    els.summary.textContent = `Running… (${done.length}/${CASES.length})`;
    els.summary.style.color = "#999";
    return;
  }
  const failed = CASES.filter((c) => c.status === "fail");
  if (failed.length === 0) {
    els.summary.textContent = "ALL PASS — every body-type pairing correctly collides.";
    els.summary.style.color = "#66bb6a";
  } else {
    els.summary.textContent = `${failed.length} of ${CASES.length} pairing(s) FAILED — see below.`;
    els.summary.style.color = "#ef5350";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds one mover + one wall entity for a single test case inside the
 * given (freshly cleared) world.
 */
function spawnCase(world, c) {
  const wall = world.createEntity("Wall_" + c.id, "Test");
  wall.addComponent(TRANSFORM, new Transform({ x: WALL_X, y: 0 }));
  wall.addComponent(
    RIGIDBODY_2D,
    new Rigidbody2D({
      bodyType: c.wallType,
      simulated: true,
      // Push case: don't fall, so a successful shove reads as clean
      // horizontal displacement, not vertical fall confusing the
      // X-only pass/fail check below. Mass itself is intentionally
      // left at its default (no Rigidbody2D.mass override) — real
      // mass for a Dynamic body comes from Collider2D.density below,
      // matching the actual Inspector workflow (this is the exact
      // "density 0.1" setup that exposed the additional-mass bug).
      gravityScale: c.pushTest ? 0 : undefined,
    })
  );
  wall.addComponent(
    COLLIDER_2D,
    new Collider2D({
      width: WALL_HALF * 2,
      height: 200,
      // Light density for the push case — low enough that even a
      // moderate-speed kinematic mover should shove it clearly. Left
      // at the Collider2D default (1) for every other case since they
      // don't care about mass at all (Static/Kinematic walls ignore
      // it, and dynamic-vs-static doesn't push anything).
      density: c.pushTest ? 0.1 : undefined,
    })
  );

  const mover = world.createEntity("Mover_" + c.id, "Test");
  mover.addComponent(TRANSFORM, new Transform({ x: START_X, y: 0 }));
  const rb = new Rigidbody2D({
    bodyType: c.moverType,
    simulated: true,
    velocityX: MOVER_SPEED,
    velocityY: 0,
    gravityScale: 0,
  });
  mover.addComponent(RIGIDBODY_2D, rb);
  mover.addComponent(COLLIDER_2D, new Collider2D({ width: MOVER_HALF * 2, height: MOVER_HALF * 2 }));

  return { wall, mover, rb };
}

/**
 * Runs exactly one case to completion, stepping the SAME world/physics
 * every real animation frame (not a synchronous burst) so the canvas
 * visibly shows the mover travelling and hitting (or missing) the wall.
 * Resolves once the mover either crosses the wall's far side (fail) or
 * CASE_TIME_LIMIT real seconds have elapsed (pass/fail decided from the
 * final resting position).
 */
function runCaseVisually(world, c, mover, rb, wall) {
  return new Promise((resolve) => {
    let elapsed = 0;
    let lastT = performance.now();
    let frameCount = 0;
    const wallStartX = wall.getComponent(TRANSFORM).x;

    function frame(now) {
      const dt = Math.min(1 / 30, (now - lastT) / 1000); // clamp huge tab-switch gaps
      lastT = now;
      elapsed += dt;
      frameCount++;

      // Re-seed velocity every frame BEFORE stepping — matches how a real
      // gameplay script/controller would drive movement continuously,
      // rather than relying on a single initial value that some body
      // types (Dynamic in particular) don't even read from the
      // constructor at all:
      //  - Dynamic bodies only take velocity from driveVelocityX/Y (a
      //    one-shot transient field PhysicsWorld clears every frame —
      //    see PhysicsWorld._syncEntity), NOT from velocityX/Y.
      //  - Kinematic bodies DO read velocityX/Y directly every frame, so
      //    setting it once at spawn is technically enough, but re-seeding
      //    it here too keeps both code paths visibly parallel.
      if (c.moverType === BodyType.DYNAMIC) {
        rb.driveVelocityX = MOVER_SPEED;
        rb.driveVelocityY = 0;
      } else if (c.moverType === BodyType.KINEMATIC) {
        rb.velocityX = MOVER_SPEED;
        rb.velocityY = 0;
      }

      world.update(dt);

      const t = mover.getComponent(TRANSFORM);
      const wt = wall.getComponent(TRANSFORM);
      if (frameCount % 15 === 0) {
        console.log(
          `[collision-test] "${c.id}" frame ${frameCount} t=${elapsed.toFixed(2)}s mover.x=${t.x.toFixed(1)} box.x=${wt.x.toFixed(1)} boxPushed=${(wt.x - wallStartX).toFixed(1)}`
        );
      }
      // For the push case, the wall (box) itself moves, so "mover.x past
      // the box's ORIGINAL position" is meaningless as an early-exit
      // signal — the box has usually already been shoved further along,
      // and ending here just cuts the push short before it can
      // accumulate. Only the plain blocking cases use that early exit;
      // the push case always runs the full CASE_TIME_LIMIT.
      const passedThrough = !c.pushTest && t.x > WALL_X + WALL_HALF;

      if (passedThrough || elapsed >= CASE_TIME_LIMIT) {
        resolve({ moverX: t.x, wallX: wt.x, wallPushedBy: wt.x - wallStartX });
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

async function run() {
  const mount = document.getElementById("game-canvas");
  const pixiApp = new PIXI.Application({
    width: mount.clientWidth || 480,
    height: mount.clientHeight || 200,
    backgroundColor: 0x1b1b1b,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true });
  const world = game.world;
  world.clear();

  CASES.forEach((c) => (c.status = "pending"));
  renderCases();
  updateSummary("Waiting for physics engine to load…");

  const physicsSystem = world.systems.find((s) => s.constructor.name === "PhysicsSystem");
  await physicsSystem.physicsWorld.whenReady();

  // Explicit 2s pause AFTER whenReady() resolves — purely so the
  // "Waiting…" state is visibly readable and Rapier has settled before
  // the first case's very first step, rather than the first case
  // appearing to start mid-load.
  updateSummary("Physics engine loaded — starting in 2s…");
  await sleep(2000);

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    updateSummary(`Running case ${i + 1}/${CASES.length}: ${c.title}…`);

    // Fresh world per case: a stale wall/mover pair from the previous
    // case (which may already be resting mid-canvas) would visually
    // clutter the scene and could theoretically leave old Rapier
    // colliders behind if cleanup ever regressed. world.clear() also
    // resets the entity id counter, matching normal scene-load behavior.
    world.clear();
    const { wall, mover, rb } = spawnCase(world, c);

    console.log(`[collision-test] starting "${c.id}" — mover@${START_X}, wall@${WALL_X}`);
    const result = await runCaseVisually(world, c, mover, rb, wall);
    console.log(
      `[collision-test] "${c.id}" finished — mover.x=${result.moverX.toFixed(1)} box.x=${result.wallX.toFixed(1)} pushedBy=${result.wallPushedBy.toFixed(1)}`
    );

    if (c.pushTest) {
      // Bulldozer check: this case doesn't care where the MOVER ends up
      // (it's expected to keep advancing, shoving the box ahead of it)
      // — it cares whether the box was actually displaced forward.
      // MIN_PUSH_DISTANCE is well below what a real sustained push over
      // the full CASE_TIME_LIMIT should achieve (mover travels up to
      // MOVER_SPEED * CASE_TIME_LIMIT = 1200px if totally unobstructed),
      // but high enough that a single-frame nudge or near-miss contact
      // can't accidentally pass.
      const MIN_PUSH_DISTANCE = 80; // px
      const pushed = result.wallPushedBy >= MIN_PUSH_DISTANCE;
      if (pushed) {
        c.status = "pass";
        c.detail = `Box was pushed ${result.wallPushedBy.toFixed(1)}px forward (from x=${WALL_X} to x=${result.wallX.toFixed(1)}) — kinematic mover is correctly shoving dynamic bodies.`;
      } else {
        c.status = "fail";
        c.detail = `Box only moved ${result.wallPushedBy.toFixed(1)}px — expected ≥${MIN_PUSH_DISTANCE}px. The kinematic mover is NOT pushing the dynamic body (bulldozer push is not working).`;
      }
      renderCases();
      updateSummary();
      await sleep(600);
      continue;
    }

    const finalX = result.moverX;
    const passedThrough = finalX > WALL_X + WALL_HALF;
    const blockedCorrectly = Math.abs(finalX - EXPECTED_REST_X) <= SLOP;

    if (passedThrough) {
      c.status = "fail";
      c.detail = `Mover ended at x=${finalX.toFixed(1)} — it passed straight through the wall (wall near face is at x=${(WALL_X - WALL_HALF).toFixed(0)}).`;
    } else if (blockedCorrectly) {
      c.status = "pass";
      c.detail = `Mover correctly stopped at x=${finalX.toFixed(1)} (expected ≈${EXPECTED_REST_X.toFixed(1)}).`;
    } else {
      c.status = "fail";
      c.detail = `Mover stopped at x=${finalX.toFixed(1)}, but expected ≈${EXPECTED_REST_X.toFixed(1)} (±${SLOP}) — check for penetration/solver softness.`;
    }

    renderCases();
    updateSummary();
    // Brief pause between cases so a human watching can register the
    // previous case's final frame before the canvas resets for the next.
    await sleep(600);
  }

  updateSummary();
  window.__zengineCollisionTest = { world, cases: CASES };
}

run();


/**
 * runtime/core/GameLoop.js
 *
 * Drives World.update() every frame via requestAnimationFrame. This is
 * what makes the game "standalone" — play.html only needs a World and a
 * GameLoop, nothing from /editor.
 *
 * RUNTIME-ONLY FILE.
 */

export class GameLoop {
  /**
   * @param {import('./World.js').World} world
   * @param {object} [opts]
   * @param {() => void} [opts.onTick] called after world.update each frame
   */
  constructor(world, opts) {
    this.world = world;
    this.onTick = (opts && opts.onTick) || null;

    this._running = false;
    this._lastTime = 0;
    this._rafHandle = null;
    this._tickFn = this._tick.bind(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._rafHandle = requestAnimationFrame(this._tickFn);
  }

  stop() {
    this._running = false;
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  get isRunning() {
    return this._running;
  }

  _tick(now) {
    if (!this._running) return;

    const dt = Math.min(0.1, (now - this._lastTime) / 1000); // clamp to avoid huge jumps after tab-out
    this._lastTime = now;

    this.world.update(dt);
    if (this.onTick) this.onTick(dt);

    this._rafHandle = requestAnimationFrame(this._tickFn);
  }
}

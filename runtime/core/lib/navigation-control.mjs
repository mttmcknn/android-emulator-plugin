import { combineAbortSignals } from './abort-signals.mjs';

// A global preference gates every navigation entry point and owns only work
// started by this helper. Disabling drains it before a new generation can run.
export const MINIMAP_DISABLED = 'Minimap tracking is disabled. Enable Minimap tracking in plugin settings or Device controls to remember screens and use saved navigation. Saved maps are preserved.';

export class NavigationControl {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.controller = new AbortController();
    this.active = new Set();
  }

  assertEnabled() {
    if (!this.enabled) throw new Error(MINIMAP_DISABLED);
  }

  run(work, { signal } = {}) {
    this.assertEnabled();
    const { signal: combined, dispose } = combineAbortSignals([this.controller.signal, signal]);
    combined.throwIfAborted();
    const done = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return work(combined);
    }).then(value => {
      combined.throwIfAborted();
      return value;
    }).finally(dispose);
    this.active.add(done);
    const remove = () => this.active.delete(done);
    done.then(remove, remove);
    return done;
  }

  async disable() {
    this.enabled = false;
    this.controller.abort(new Error(MINIMAP_DISABLED));
    await Promise.allSettled([...this.active]);
  }

  enable() {
    if (this.enabled) return;
    if (this.active.size) throw new Error('Minimap is still stopping. Wait before enabling it again.');
    this.controller = new AbortController();
    this.enabled = true;
  }
}

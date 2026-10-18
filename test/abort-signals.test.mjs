import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { combineAbortSignals } from '../runtime/core/lib/abort-signals.mjs';
import { NavigationControl } from '../runtime/core/lib/navigation-control.mjs';

const listeners = signal => getEventListeners(signal, 'abort').length;
function withoutNativeAny(t) {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    else delete AbortSignal.any;
  });
}

test('signal composition preserves an already-aborted reason without attaching listeners', t => {
  withoutNativeAny(t);
  const live = new AbortController(), first = new AbortController(), second = new AbortController();
  const reason = new Error('already cancelled');
  first.abort(reason); second.abort(new Error('later source'));
  const combined = combineAbortSignals([live.signal, first.signal, second.signal]);
  assert.equal(combined.signal.aborted, true);
  assert.equal(combined.signal.reason, reason);
  for (const source of [live, first, second]) assert.equal(listeners(source.signal), 0);
  combined.dispose();
});

test('either source aborts the combined signal once and detaches every listener', t => {
  withoutNativeAny(t);
  for (const abortIndex of [0, 1]) {
    const sources = [new AbortController(), new AbortController()];
    const combined = combineAbortSignals(sources.map(source => source.signal));
    for (const source of sources) assert.equal(listeners(source.signal), 1);
    let aborted = 0;
    combined.signal.addEventListener('abort', () => { aborted++; });
    const reason = new Error(`source ${abortIndex}`);
    sources[abortIndex].abort(reason);
    assert.equal(combined.signal.reason, reason);
    assert.equal(aborted, 1);
    for (const source of sources) assert.equal(listeners(source.signal), 0);
    sources[1 - abortIndex].abort(new Error('later cancellation'));
    assert.equal(combined.signal.reason, reason);
    assert.equal(aborted, 1);
    combined.dispose();
  }
});

test('disposing a completed composition is idempotent and leaves caller listeners intact', t => {
  withoutNativeAny(t);
  const a = new AbortController(), b = new AbortController();
  let callerAborts = 0;
  a.signal.addEventListener('abort', () => { callerAborts++; });
  const combined = combineAbortSignals([a.signal, a.signal, undefined, b.signal]);
  assert.equal(listeners(a.signal), 2, 'duplicate input signals share one owned listener');
  assert.equal(listeners(b.signal), 1);
  combined.dispose(); combined.dispose();
  assert.equal(listeners(a.signal), 1);
  assert.equal(listeners(b.signal), 0);
  a.abort(); b.abort();
  assert.equal(callerAborts, 1);
  assert.equal(combined.signal.aborted, false);
});

test('navigation releases combined-signal listeners on success, failure and immediate cancellation', async t => {
  withoutNativeAny(t);
  const control = new NavigationControl(), parent = new AbortController();
  for (const fails of [false, true]) {
    const done = control.run(signal => {
      assert.equal(listeners(control.controller.signal), 1);
      assert.equal(listeners(parent.signal), 1);
      signal.throwIfAborted();
      if (fails) throw new Error('work failed');
      return 'finished';
    }, { signal: parent.signal });
    if (fails) await assert.rejects(done, /work failed/);
    else assert.equal(await done, 'finished');
    assert.equal(control.active.size, 0);
    assert.equal(listeners(control.controller.signal), 0);
    assert.equal(listeners(parent.signal), 0);
  }
  const reason = new Error('cancelled before start');
  parent.abort(reason);
  assert.throws(() => control.run(() => assert.fail('must not start'), { signal: parent.signal }), error => error === reason);
  assert.equal(control.active.size, 0);
  assert.equal(listeners(control.controller.signal), 0);
});

test('navigation disable forwards cancellation and drains owned cleanup without native any', async t => {
  withoutNativeAny(t);
  const control = new NavigationControl(), parent = new AbortController();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const running = control.run(async signal => {
    enter();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup;
    return 'stale result';
  }, { signal: parent.signal });
  const rejected = assert.rejects(running, /Minimap tracking is disabled/);
  await entered;
  let stopped = false;
  const disabling = control.disable().then(() => { stopped = true; });
  assert.equal(listeners(parent.signal), 0);
  assert.equal(listeners(control.controller.signal), 0);
  assert.equal(stopped, false);
  assert.throws(() => control.enable(), /still stopping/);
  release();
  await rejected;
  await disabling;
  assert.equal(stopped, true);
  control.enable();
  assert.equal(await control.run(() => 'new generation', { signal: parent.signal }), 'new generation');
  assert.equal(listeners(parent.signal), 0);
});

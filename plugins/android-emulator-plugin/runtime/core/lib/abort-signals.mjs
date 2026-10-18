// AbortSignal.any is missing in early Node 20 releases. Explicit disposal also
// keeps completed operations from retaining listeners on long-lived signals.
export function combineAbortSignals(signals) {
  const sources = [...new Set(signals.filter(Boolean))];
  if (sources.length === 1) return { signal: sources[0], dispose() {} };
  const controller = new AbortController();
  const listeners = new Map();
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  const aborted = sources.find(signal => signal.aborted);
  if (aborted) controller.abort(aborted.reason);
  else for (const signal of sources) {
    const listener = () => {
      dispose();
      controller.abort(signal.reason);
    };
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return { signal: controller.signal, dispose };
}

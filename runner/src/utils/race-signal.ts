/**
 * Race a promise against an AbortSignal.
 * Rejects with DOMException('Aborted', 'AbortError') if the signal fires first.
 */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
      .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

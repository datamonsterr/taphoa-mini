/** Freezes `Date` only; timers, microtasks and rAF stay real so async test utilities still run. */
export function freezeDate(at: string | number | Date): void {
  jest.useFakeTimers({
    now: new Date(at),
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'queueMicrotask',
      'nextTick',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
}

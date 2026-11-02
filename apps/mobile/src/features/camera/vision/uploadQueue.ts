/** FIFO upload queue. Failed jobs reject their caller without blocking subsequent frames. */
export function createUploadQueue(concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid concurrency');
  const waiting: (() => void)[] = [];
  const idle: (() => void)[] = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && waiting.length) waiting.shift()!();
    if (!running && !waiting.length)
      idle.splice(0).forEach((resolve) => resolve());
  };
  return {
    add<T>(job: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          running++;
          void (async () => job())()
            .then(resolve, reject)
            .finally(() => {
              running--;
              pump();
            });
        });
        pump();
      });
    },
    drain(): Promise<void> {
      return running || waiting.length
        ? new Promise((resolve) => idle.push(resolve))
        : Promise.resolve();
    },
  };
}

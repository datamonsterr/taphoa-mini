/**
 * Holds the next call to `module[method]` open until `release()`, then resolves it with the real
 * implementation. The mock API has zero latency in tests, so a loading state is otherwise gone
 * before the first assertion. Needs `jest.restoreAllMocks()` in afterEach.
 */
export function holdNext<M extends object, K extends keyof M>(
  module: M,
  method: K,
): () => void {
  type Fn = (...args: never[]) => Promise<unknown>;
  const real = module[method] as unknown as Fn;
  let release: () => void = () => {};
  jest.spyOn(module as never, method as never).mockImplementationOnce(
    ((...args: never[]) =>
      new Promise((resolve) => {
        release = () => resolve(real(...args));
      })) as never,
  );
  return () => release();
}

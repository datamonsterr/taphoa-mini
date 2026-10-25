/** React registers the active Clerk session here; transports never call hooks. */
type AuthBridge = {
  userId?: string | null;
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>;
  getStoreId: () => string | null;
  membershipRequired: () => void;
};
let bridge: AuthBridge | null = null;
const listeners = new Set<() => void>();
export const subscribeAuthBridge = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const bridgeUserId = () => bridge?.userId;
export const serverBridgeUserId = () => undefined;

export function registerAuthBridge(next: AuthBridge): () => void {
  bridge = next;
  listeners.forEach((listener) => listener());
  return () => {
    if (bridge === next) {
      bridge = null;
      listeners.forEach((listener) => listener());
    }
  };
}
export const clerkToken = (options?: { skipCache?: boolean }) =>
  bridge?.getToken(options) ?? Promise.resolve(null);
export const currentStoreId = () => bridge?.getStoreId() ?? null;
export const membershipRequired = () => bridge?.membershipRequired();

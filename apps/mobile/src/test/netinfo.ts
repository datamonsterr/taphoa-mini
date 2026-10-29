type State = { isConnected: boolean | null };
type Listener = (state: State) => void;

const listeners = new Set<Listener>();
let current: State = { isConnected: true };

/** Stand-in for `@react-native-community/netinfo`: connected until a test calls `__emit`. */
const api = {
  configure: jest.fn(),
  addEventListener: jest.fn((listener: Listener) => {
    listeners.add(listener);
    listener(current);
    return () => {
      listeners.delete(listener);
    };
  }),
  fetch: jest.fn(async (): Promise<State> => ({ isConnected: true })),
  __emit: (state: State) => {
    current = state;
    listeners.forEach((listener) => listener(state));
  },
};

module.exports = { __esModule: true, default: api, ...api };

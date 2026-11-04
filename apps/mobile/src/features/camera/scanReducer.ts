import type { Scan } from '@/lib/api/types';

import { isLowMatch } from './matching';

export type Photo = { uri: string; width: number; height: number };

export type ScanPhase = 'idle' | 'capturing' | 'scanning' | 'result' | 'error';

export type ScanState = {
  phase: ScanPhase;
  /** Id of the request whose answer may still change the state. */
  token: number;
  photo?: Photo;
  scan?: Scan;
  error?: string;
  /** Detection id -> in the batch. Missing means deselected. Only `matched` starts in; low matches never. */
  selected: Record<string, boolean>;
  /** Detection id -> product id picked from the strip, replacing the top-1. */
  chosen: Record<string, string>;
  /** Detection whose alternatives strip is open. */
  openId: string | null;
};

export type ScanAction =
  | { type: 'shutter'; token: number }
  | { type: 'captured'; token: number; photo: Photo }
  | { type: 'scanned'; token: number; scan: Scan; open?: boolean }
  | { type: 'failed'; token: number; message: string }
  | { type: 'retry'; token: number }
  | { type: 'toggle'; id: string }
  | { type: 'toggleOpen'; id: string }
  | { type: 'choose'; id: string; productId: string }
  | { type: 'added' }
  | { type: 'reset' };

export const initialScanState: ScanState = {
  phase: 'idle',
  token: 0,
  selected: {},
  chosen: {},
  openId: null,
};

/** Capture session: idle, capturing, scanning, then result or error. Stale answers are dropped. */
export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case 'shutter':
      if (state.phase !== 'idle') return state;
      return { ...initialScanState, phase: 'capturing', token: action.token };

    case 'captured':
      if (state.phase !== 'capturing' || action.token !== state.token) {
        return state;
      }
      return { ...state, phase: 'scanning', photo: action.photo };

    case 'scanned': {
      if (state.phase !== 'scanning' || action.token !== state.token) {
        return state;
      }
      const selected: Record<string, boolean> = {};
      for (const detection of action.scan.detections) {
        if (detection.match === 'matched' && !isLowMatch(detection)) {
          selected[detection.id] = true;
        }
      }
      // Board 02: a single-item scan opens the candidate strip at once.
      const first = action.open
        ? action.scan.detections.find((d) => !isLowMatch(d))
        : undefined;
      return {
        ...state,
        phase: 'result',
        scan: action.scan,
        selected,
        openId: first?.id ?? null,
      };
    }

    case 'failed':
      if (
        (state.phase !== 'capturing' && state.phase !== 'scanning') ||
        action.token !== state.token
      ) {
        return state;
      }
      return { ...state, phase: 'error', error: action.message };

    case 'retry':
      if (state.phase !== 'error' || !state.photo) return state;
      return {
        ...state,
        phase: 'scanning',
        token: action.token,
        error: undefined,
      };

    case 'toggle': {
      const detection = findDetection(state, action.id);
      if (!detection || isLowMatch(detection)) return state;
      return {
        ...state,
        selected: {
          ...state.selected,
          [action.id]: !state.selected[action.id],
        },
      };
    }

    case 'toggleOpen': {
      const detection = findDetection(state, action.id);
      if (!detection || isLowMatch(detection)) return state;
      return {
        ...state,
        openId: state.openId === action.id ? null : action.id,
      };
    }

    case 'choose': {
      const detection = findDetection(state, action.id);
      if (
        !detection ||
        !detection.candidates.some((c) => c.product_id === action.productId)
      ) {
        return state;
      }
      return {
        ...state,
        chosen: { ...state.chosen, [action.id]: action.productId },
        selected: { ...state.selected, [action.id]: true },
      };
    }

    case 'added': {
      if (state.phase !== 'result' || !state.scan) return state;
      // Gone: what went to the cart, and matched boxes the seller deselected on purpose. Kept:
      // unknown boxes and ambiguous ones nobody picked, so the seller can still enroll them.
      const remaining = state.scan.detections.filter(
        (d) =>
          isLowMatch(d) || (d.match === 'ambiguous' && !state.selected[d.id]),
      );
      if (remaining.length === 0) {
        return { ...initialScanState, token: state.token };
      }
      const keep = new Set(remaining.map((d) => d.id));
      return {
        ...state,
        scan: { ...state.scan, detections: remaining },
        selected: {},
        chosen: Object.fromEntries(
          Object.entries(state.chosen).filter(([id]) => keep.has(id)),
        ),
        openId: null,
      };
    }

    case 'reset':
      if (state.phase === 'idle') return state;
      return { ...initialScanState, token: state.token };
  }
}

function findDetection(state: ScanState, id: string) {
  return state.phase === 'result'
    ? state.scan?.detections.find((d) => d.id === id)
    : undefined;
}

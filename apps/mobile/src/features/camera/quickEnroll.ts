import { create, type StoreApi, type UseBoundStore } from 'zustand';

export const MIN_SHOTS = 3;
export const MAX_SHOTS = 8;
export const MAX_POINTS = 2;

export type QuickPoint = { x: number; y: number; label: 0 | 1 }; // photo pixel coords

export type ShotStatus =
  'uploading' | 'pointing' | 'segmenting' | 'accepted' | 'error';

export type Shot = {
  id: string; // local id
  uri: string;
  width: number;
  height: number; // downsized photo
  imageId?: string; // server image id after upload
  points: QuickPoint[];
  mask?: { width: number; height: number; pngBase64: string };
  bbox?: [number, number, number, number];
  cutoutImageId?: string;
  status: ShotStatus;
  error?: string;
};

export type QuickEnrollState = {
  active: boolean;
  shots: Shot[];
  currentId?: string;
};

export type QuickEnrollAction =
  | { type: 'toggle' } // on: active=true; off: resets everything
  | { type: 'discard' } // reset shots, keep active
  | { type: 'captured'; id: string; uri: string; width: number; height: number } // ignored when !active or accepted count >= MAX_SHOTS; becomes current, status 'uploading'
  | { type: 'uploaded'; id: string; imageId: string } // -> 'pointing'
  | { type: 'addPoint'; point: QuickPoint } // on current shot; when already MAX_POINTS points, the new one REPLACES the second (last) point; clears mask/bbox/cutout; status 'pointing'
  | { type: 'undoPoint' } // removes last point of current shot, clears mask
  | { type: 'segmenting' } // current -> 'segmenting'
  | {
      type: 'segmented';
      id: string;
      mask: Shot['mask'];
      bbox: Shot['bbox'];
      cutoutImageId: string;
    } // -> 'pointing' with mask (ready to accept); ignore if shot's points changed meanwhile is NOT required
  | { type: 'failed'; id: string; error: string } // -> 'error'
  | { type: 'accept' } // current shot with mask -> 'accepted', currentId cleared; no-op without mask
  | { type: 'retake' } // removes current shot, currentId cleared
  | { type: 'remove'; id: string }; // remove an accepted shot (sheet photo row)

export const initialQuickEnroll: QuickEnrollState = {
  active: false,
  shots: [],
  currentId: undefined,
};

export function quickEnrollReducer(
  state: QuickEnrollState,
  action: QuickEnrollAction,
): QuickEnrollState {
  switch (action.type) {
    case 'toggle':
      if (state.active) {
        return initialQuickEnroll;
      }
      return { ...state, active: true };

    case 'discard':
      return { ...state, shots: [], currentId: undefined };

    case 'captured': {
      if (!state.active || selectAccepted(state).length >= MAX_SHOTS) {
        return state;
      }
      const shot: Shot = {
        id: action.id,
        uri: action.uri,
        width: action.width,
        height: action.height,
        points: [],
        status: 'uploading',
      };
      return {
        ...state,
        shots: [...state.shots, shot],
        currentId: action.id,
      };
    }

    case 'uploaded': {
      const shot = state.shots.find((s) => s.id === action.id);
      if (!shot) return state;
      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === action.id
            ? {
                ...s,
                imageId: action.imageId,
                status: 'pointing',
                error: undefined,
              }
            : s,
        ),
      };
    }

    case 'addPoint': {
      if (!state.currentId) return state;
      const current = selectCurrent(state);
      if (!current) return state;

      const newPoints =
        current.points.length >= MAX_POINTS
          ? [...current.points.slice(0, MAX_POINTS - 1), action.point]
          : [...current.points, action.point];

      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === state.currentId
            ? {
                ...s,
                points: newPoints,
                mask: undefined,
                bbox: undefined,
                cutoutImageId: undefined,
                error: undefined,
                status: 'pointing',
              }
            : s,
        ),
      };
    }

    case 'undoPoint': {
      if (!state.currentId) return state;
      const current = selectCurrent(state);
      if (!current || current.points.length === 0) return state;

      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === state.currentId
            ? {
                ...s,
                points: s.points.slice(0, -1),
                mask: undefined,
                bbox: undefined,
                cutoutImageId: undefined,
                error: undefined,
                status: 'pointing',
              }
            : s,
        ),
      };
    }

    case 'segmenting': {
      if (!state.currentId) return state;
      const current = selectCurrent(state);
      if (!current) return state;

      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === state.currentId
            ? {
                ...s,
                status: 'segmenting',
              }
            : s,
        ),
      };
    }

    case 'segmented': {
      const shot = state.shots.find((s) => s.id === action.id);
      if (!shot) return state;

      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === action.id
            ? {
                ...s,
                mask: action.mask,
                bbox: action.bbox,
                cutoutImageId: action.cutoutImageId,
                status: 'pointing',
                error: undefined,
              }
            : s,
        ),
      };
    }

    case 'failed': {
      const shot = state.shots.find((s) => s.id === action.id);
      if (!shot) return state;

      return {
        ...state,
        shots: state.shots.map((s) =>
          s.id === action.id
            ? {
                ...s,
                status: 'error',
                error: action.error,
              }
            : s,
        ),
      };
    }

    case 'accept': {
      const current = selectCurrent(state);
      if (!current || !current.mask) return state;

      return {
        ...state,
        currentId: undefined,
        shots: state.shots.map((s) =>
          s.id === current.id
            ? {
                ...s,
                status: 'accepted',
              }
            : s,
        ),
      };
    }

    case 'retake': {
      if (!state.currentId) return state;
      return {
        ...state,
        currentId: undefined,
        shots: state.shots.filter((s) => s.id !== state.currentId),
      };
    }

    case 'remove': {
      return {
        ...state,
        currentId: state.currentId === action.id ? undefined : state.currentId,
        shots: state.shots.filter((s) => s.id !== action.id),
      };
    }
  }
}

// selectors
export const selectAccepted = (s: QuickEnrollState): Shot[] =>
  s.shots.filter((shot) => shot.status === 'accepted');

export const selectCurrent = (s: QuickEnrollState): Shot | undefined =>
  s.currentId ? s.shots.find((shot) => shot.id === s.currentId) : undefined;

export const selectCanAdd = (s: QuickEnrollState): boolean =>
  selectAccepted(s).length >= MIN_SHOTS;

export const selectCanCapture = (s: QuickEnrollState): boolean =>
  s.active && !selectCurrent(s) && selectAccepted(s).length < MAX_SHOTS;

export const selectCanNext = (s: QuickEnrollState): boolean => {
  const current = selectCurrent(s);
  return Boolean(current && current.mask && current.status === 'pointing');
};

export const selectReferences = (
  s: QuickEnrollState,
): {
  image_id: string;
  cutout_image_id: string;
  bbox: [number, number, number, number];
}[] =>
  selectAccepted(s)
    .filter(
      (
        shot,
      ): shot is Shot & {
        imageId: string;
        cutoutImageId: string;
        bbox: [number, number, number, number];
      } => Boolean(shot.imageId && shot.cutoutImageId && shot.bbox),
    )
    .map((shot) => ({
      image_id: shot.imageId,
      cutout_image_id: shot.cutoutImageId,
      bbox: shot.bbox,
    }));

// zustand store wrapping the reducer
export const useQuickEnrollStore: UseBoundStore<
  StoreApi<QuickEnrollState & { dispatch: (a: QuickEnrollAction) => void }>
> = create<QuickEnrollState & { dispatch: (a: QuickEnrollAction) => void }>()(
  (set) => ({
    ...initialQuickEnroll,
    dispatch: (action) => set((state) => quickEnrollReducer(state, action)),
  }),
);

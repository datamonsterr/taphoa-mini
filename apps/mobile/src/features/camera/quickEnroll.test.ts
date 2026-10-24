import {
  initialQuickEnroll,
  MAX_POINTS,
  MAX_SHOTS,
  MIN_SHOTS,
  quickEnrollReducer,
  selectAccepted,
  selectCanAdd,
  selectCanCapture,
  selectCanNext,
  selectCurrent,
  selectReferences,
  useQuickEnrollStore,
  type QuickEnrollAction,
  type QuickEnrollState,
  type QuickPoint,
  type Shot,
} from './quickEnroll';

function run(
  actions: QuickEnrollAction[],
  from: QuickEnrollState = initialQuickEnroll,
) {
  return actions.reduce(quickEnrollReducer, from);
}

const samplePhoto = {
  id: 'shot-1',
  uri: 'file:///photo-1.jpg',
  width: 1024,
  height: 768,
};

const sampleMask = {
  width: 256,
  height: 192,
  pngBase64: 'iVBORw0KGgoAAAANSUhEUg==',
};

const sampleBbox: [number, number, number, number] = [100, 120, 300, 400];

describe('quickEnroll state machine', () => {
  describe('constants & initial state', () => {
    it('defines MIN_SHOTS=3, MAX_SHOTS=8, MAX_POINTS=2', () => {
      expect(MIN_SHOTS).toBe(3);
      expect(MAX_SHOTS).toBe(8);
      expect(MAX_POINTS).toBe(2);
    });

    it('initial state is inactive and empty', () => {
      expect(initialQuickEnroll).toEqual({
        active: false,
        shots: [],
        currentId: undefined,
      });
    });
  });

  describe('toggle', () => {
    it('turns on quick enroll mode', () => {
      const state = quickEnrollReducer(initialQuickEnroll, { type: 'toggle' });
      expect(state.active).toBe(true);
      expect(state.shots).toEqual([]);
      expect(state.currentId).toBeUndefined();
    });

    it('turning off resets everything to initial state', () => {
      const activeState: QuickEnrollState = {
        active: true,
        shots: [
          {
            id: 'shot-1',
            uri: 'file:///p1.jpg',
            width: 1024,
            height: 768,
            points: [{ x: 10, y: 20, label: 1 }],
            status: 'accepted',
          },
        ],
        currentId: 'shot-1',
      };

      const offState = quickEnrollReducer(activeState, { type: 'toggle' });
      expect(offState).toEqual(initialQuickEnroll);
    });
  });

  describe('discard', () => {
    it('resets shots and currentId while keeping active true', () => {
      const withShots: QuickEnrollState = {
        active: true,
        shots: [
          {
            id: 'shot-1',
            uri: 'file:///p1.jpg',
            width: 1024,
            height: 768,
            points: [],
            status: 'accepted',
          },
        ],
        currentId: 'shot-1',
      };

      const discarded = quickEnrollReducer(withShots, { type: 'discard' });
      expect(discarded).toEqual({
        active: true,
        shots: [],
        currentId: undefined,
      });
    });
  });

  describe('captured', () => {
    it('is ignored when not active', () => {
      const state = quickEnrollReducer(initialQuickEnroll, {
        type: 'captured',
        ...samplePhoto,
      });
      expect(state).toBe(initialQuickEnroll);
    });

    it('captures a shot when active, sets currentId and status uploading', () => {
      const activeState = run([{ type: 'toggle' }]);
      const state = quickEnrollReducer(activeState, {
        type: 'captured',
        ...samplePhoto,
      });

      expect(state.shots).toHaveLength(1);
      expect(state.currentId).toBe(samplePhoto.id);
      expect(state.shots[0]).toEqual({
        id: samplePhoto.id,
        uri: samplePhoto.uri,
        width: samplePhoto.width,
        height: samplePhoto.height,
        points: [],
        status: 'uploading',
      });
    });

    it('is ignored when accepted count reaches MAX_SHOTS (8)', () => {
      const acceptedShots: Shot[] = Array.from({ length: 8 }, (_, i) => ({
        id: `s-${i}`,
        uri: `file:///s-${i}.jpg`,
        width: 1024,
        height: 768,
        points: [],
        status: 'accepted',
      }));

      const stateAtMax: QuickEnrollState = {
        active: true,
        shots: acceptedShots,
      };

      const afterCapture = quickEnrollReducer(stateAtMax, {
        type: 'captured',
        id: 'shot-9',
        uri: 'file:///photo-9.jpg',
        width: 1024,
        height: 768,
      });

      expect(afterCapture).toBe(stateAtMax);
      expect(afterCapture.shots).toHaveLength(8);
    });

    it('allows capture when unaccepted shots exist but accepted count is under MAX_SHOTS', () => {
      const shots: Shot[] = Array.from({ length: 7 }, (_, i) => ({
        id: `s-${i}`,
        uri: `file:///s-${i}.jpg`,
        width: 1024,
        height: 768,
        points: [],
        status: 'accepted',
      }));

      const state: QuickEnrollState = {
        active: true,
        shots,
      };

      const next = quickEnrollReducer(state, {
        type: 'captured',
        id: 's-7',
        uri: 'file:///s-7.jpg',
        width: 1024,
        height: 768,
      });

      expect(next.shots).toHaveLength(8);
      expect(next.currentId).toBe('s-7');
    });
  });

  describe('uploaded', () => {
    it('sets imageId and transitions status to pointing', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-123' },
      ]);

      const current = selectCurrent(state);
      expect(current?.imageId).toBe('img-123');
      expect(current?.status).toBe('pointing');
    });

    it('clears error if previously errored', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'failed', id: samplePhoto.id, error: 'Network error' },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-123' },
      ]);

      const current = selectCurrent(state);
      expect(current?.status).toBe('pointing');
      expect(current?.error).toBeUndefined();
    });

    it('ignores unknown shot id', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
      ]);
      const next = quickEnrollReducer(state, {
        type: 'uploaded',
        id: 'unknown-id',
        imageId: 'img-999',
      });
      expect(next).toBe(state);
    });
  });

  describe('addPoint', () => {
    const pt1: QuickPoint = { x: 100, y: 150, label: 1 };
    const pt2: QuickPoint = { x: 200, y: 250, label: 0 };
    const pt3: QuickPoint = { x: 300, y: 350, label: 1 };

    it('adds first and second points', () => {
      const base = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
      ]);

      const onePoint = quickEnrollReducer(base, {
        type: 'addPoint',
        point: pt1,
      });
      expect(selectCurrent(onePoint)?.points).toEqual([pt1]);
      expect(selectCurrent(onePoint)?.status).toBe('pointing');

      const twoPoints = quickEnrollReducer(onePoint, {
        type: 'addPoint',
        point: pt2,
      });
      expect(selectCurrent(twoPoints)?.points).toEqual([pt1, pt2]);
      expect(selectCurrent(twoPoints)?.status).toBe('pointing');
    });

    it('when already at MAX_POINTS (2), the new point REPLACES the second (last) point', () => {
      const twoPoints = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: pt1 },
        { type: 'addPoint', point: pt2 },
      ]);

      const replaced = quickEnrollReducer(twoPoints, {
        type: 'addPoint',
        point: pt3,
      });

      expect(selectCurrent(replaced)?.points).toEqual([pt1, pt3]);
    });

    it('clears mask, bbox, cutout, and error when adding point', () => {
      const segmentedState = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: pt1 },
        {
          type: 'segmented',
          id: samplePhoto.id,
          mask: sampleMask,
          bbox: sampleBbox,
          cutoutImageId: 'cutout-1',
        },
      ]);

      expect(selectCurrent(segmentedState)?.mask).toBeDefined();

      const repointed = quickEnrollReducer(segmentedState, {
        type: 'addPoint',
        point: pt2,
      });

      const current = selectCurrent(repointed);
      expect(current?.mask).toBeUndefined();
      expect(current?.bbox).toBeUndefined();
      expect(current?.cutoutImageId).toBeUndefined();
      expect(current?.error).toBeUndefined();
      expect(current?.status).toBe('pointing');
    });

    it('ignores addPoint when there is no current shot', () => {
      const state = run([{ type: 'toggle' }]);
      const next = quickEnrollReducer(state, { type: 'addPoint', point: pt1 });
      expect(next).toBe(state);
    });
  });

  describe('undoPoint', () => {
    const pt1: QuickPoint = { x: 100, y: 150, label: 1 };
    const pt2: QuickPoint = { x: 200, y: 250, label: 0 };

    it('removes last point of current shot and clears mask/bbox/cutout', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: pt1 },
        { type: 'addPoint', point: pt2 },
        {
          type: 'segmented',
          id: samplePhoto.id,
          mask: sampleMask,
          bbox: sampleBbox,
          cutoutImageId: 'cutout-1',
        },
        { type: 'undoPoint' },
      ]);

      const current = selectCurrent(state);
      expect(current?.points).toEqual([pt1]);
      expect(current?.mask).toBeUndefined();
      expect(current?.bbox).toBeUndefined();
      expect(current?.cutoutImageId).toBeUndefined();
      expect(current?.status).toBe('pointing');
    });

    it('undoing with one point leaves points empty', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: pt1 },
        { type: 'undoPoint' },
      ]);

      expect(selectCurrent(state)?.points).toEqual([]);
    });

    it('no-op when points already empty', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
      ]);

      const next = quickEnrollReducer(state, { type: 'undoPoint' });
      expect(next).toBe(state);
    });

    it('ignores undoPoint when there is no current shot', () => {
      const state = run([{ type: 'toggle' }]);
      const next = quickEnrollReducer(state, { type: 'undoPoint' });
      expect(next).toBe(state);
    });
  });

  describe('segmenting, segmented, failed', () => {
    it('segmenting moves current shot to segmenting status', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: { x: 10, y: 20, label: 1 } },
        { type: 'segmenting' },
      ]);

      expect(selectCurrent(state)?.status).toBe('segmenting');
    });

    it('segmented sets mask, bbox, cutoutImageId and returns to pointing', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: { x: 10, y: 20, label: 1 } },
        { type: 'segmenting' },
        {
          type: 'segmented',
          id: samplePhoto.id,
          mask: sampleMask,
          bbox: sampleBbox,
          cutoutImageId: 'cutout-123',
        },
      ]);

      const current = selectCurrent(state);
      expect(current?.status).toBe('pointing');
      expect(current?.mask).toEqual(sampleMask);
      expect(current?.bbox).toEqual(sampleBbox);
      expect(current?.cutoutImageId).toBe('cutout-123');
      expect(current?.error).toBeUndefined();
    });

    it('failed transitions status to error with message', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'failed', id: samplePhoto.id, error: 'Segmentation timed out' },
      ]);

      const current = selectCurrent(state);
      expect(current?.status).toBe('error');
      expect(current?.error).toBe('Segmentation timed out');
    });

    it('ignores segmented/failed with unknown shot id', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
      ]);

      const seg = quickEnrollReducer(state, {
        type: 'segmented',
        id: 'bad-id',
        mask: sampleMask,
        bbox: sampleBbox,
        cutoutImageId: 'cut-1',
      });
      expect(seg).toBe(state);

      const fail = quickEnrollReducer(state, {
        type: 'failed',
        id: 'bad-id',
        error: 'err',
      });
      expect(fail).toBe(state);
    });
  });

  describe('accept', () => {
    it('no-op without mask on current shot', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: { x: 10, y: 20, label: 1 } },
      ]);

      const next = quickEnrollReducer(state, { type: 'accept' });
      expect(next).toBe(state);
      expect(selectCurrent(next)?.status).toBe('pointing');
    });

    it('current shot with mask becomes accepted, currentId is cleared', () => {
      const readyState = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        { type: 'addPoint', point: { x: 10, y: 20, label: 1 } },
        {
          type: 'segmented',
          id: samplePhoto.id,
          mask: sampleMask,
          bbox: sampleBbox,
          cutoutImageId: 'cutout-1',
        },
      ]);

      const acceptedState = quickEnrollReducer(readyState, { type: 'accept' });
      expect(acceptedState.currentId).toBeUndefined();
      expect(acceptedState.shots).toHaveLength(1);
      expect(acceptedState.shots[0].status).toBe('accepted');
      expect(selectAccepted(acceptedState)).toHaveLength(1);
    });

    it('no-op when there is no current shot', () => {
      const state = run([{ type: 'toggle' }]);
      const next = quickEnrollReducer(state, { type: 'accept' });
      expect(next).toBe(state);
    });
  });

  describe('retake', () => {
    it('removes current shot and clears currentId', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'retake' },
      ]);

      expect(state.shots).toHaveLength(0);
      expect(state.currentId).toBeUndefined();
      expect(selectCurrent(state)).toBeUndefined();
    });

    it('no-op if no currentId exists', () => {
      const state = run([{ type: 'toggle' }]);
      const next = quickEnrollReducer(state, { type: 'retake' });
      expect(next).toBe(state);
    });
  });

  describe('remove', () => {
    it('removes an accepted shot by id', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
        { type: 'uploaded', id: samplePhoto.id, imageId: 'img-1' },
        {
          type: 'segmented',
          id: samplePhoto.id,
          mask: sampleMask,
          bbox: sampleBbox,
          cutoutImageId: 'cutout-1',
        },
        { type: 'accept' },
      ]);

      expect(state.shots).toHaveLength(1);

      const removed = quickEnrollReducer(state, {
        type: 'remove',
        id: samplePhoto.id,
      });

      expect(removed.shots).toHaveLength(0);
      expect(selectAccepted(removed)).toHaveLength(0);
    });

    it('clears currentId if the removed shot happened to be current', () => {
      const state = run([
        { type: 'toggle' },
        { type: 'captured', ...samplePhoto },
      ]);

      const removed = quickEnrollReducer(state, {
        type: 'remove',
        id: samplePhoto.id,
      });

      expect(removed.shots).toHaveLength(0);
      expect(removed.currentId).toBeUndefined();
    });
  });

  describe('selectors', () => {
    function makeAcceptedShot(n: number): Shot {
      return {
        id: `shot-${n}`,
        uri: `file:///shot-${n}.jpg`,
        width: 1024,
        height: 768,
        imageId: `img-${n}`,
        points: [{ x: n, y: n, label: 1 }],
        mask: sampleMask,
        bbox: [0, 0, 100, 100],
        cutoutImageId: `cutout-${n}`,
        status: 'accepted',
      };
    }

    it('selectAccepted filters for status accepted', () => {
      const s1 = makeAcceptedShot(1);
      const s2: Shot = {
        id: 'shot-2',
        uri: 'file:///shot-2.jpg',
        width: 1024,
        height: 768,
        points: [],
        status: 'uploading',
      };

      const state: QuickEnrollState = {
        active: true,
        shots: [s1, s2],
        currentId: 'shot-2',
      };

      expect(selectAccepted(state)).toEqual([s1]);
    });

    it('selectCurrent finds shot matching currentId', () => {
      const s1 = makeAcceptedShot(1);
      const state: QuickEnrollState = {
        active: true,
        shots: [s1],
        currentId: 'shot-1',
      };
      expect(selectCurrent(state)).toEqual(s1);

      const empty: QuickEnrollState = { active: true, shots: [] };
      expect(selectCurrent(empty)).toBeUndefined();
    });

    it('selectCanAdd: false at 2 shots, true at 3 shots', () => {
      const state2: QuickEnrollState = {
        active: true,
        shots: [makeAcceptedShot(1), makeAcceptedShot(2)],
      };
      expect(selectCanAdd(state2)).toBe(false);

      const state3: QuickEnrollState = {
        active: true,
        shots: [makeAcceptedShot(1), makeAcceptedShot(2), makeAcceptedShot(3)],
      };
      expect(selectCanAdd(state3)).toBe(true);
    });

    it('selectCanCapture: active && !current && accepted.length < MAX_SHOTS', () => {
      const base: QuickEnrollState = {
        active: true,
        shots: [makeAcceptedShot(1)],
      };
      expect(selectCanCapture(base)).toBe(true);

      // inactive -> false
      expect(selectCanCapture({ ...base, active: false })).toBe(false);

      // has current shot -> false
      expect(selectCanCapture({ ...base, currentId: 'shot-1' })).toBe(false);

      // at 8 shots -> false
      const full: QuickEnrollState = {
        active: true,
        shots: Array.from({ length: 8 }, (_, i) => makeAcceptedShot(i + 1)),
      };
      expect(selectCanCapture(full)).toBe(false);
    });

    it('selectCanNext: current has mask and status pointing', () => {
      const currentWithMask: Shot = {
        id: 's1',
        uri: 'file:///s1.jpg',
        width: 1024,
        height: 768,
        points: [{ x: 1, y: 1, label: 1 }],
        mask: sampleMask,
        bbox: sampleBbox,
        cutoutImageId: 'cutout-1',
        status: 'pointing',
      };

      const validState: QuickEnrollState = {
        active: true,
        shots: [currentWithMask],
        currentId: 's1',
      };
      expect(selectCanNext(validState)).toBe(true);

      // without mask -> false
      const withoutMask: QuickEnrollState = {
        active: true,
        shots: [{ ...currentWithMask, mask: undefined }],
        currentId: 's1',
      };
      expect(selectCanNext(withoutMask)).toBe(false);

      // not status pointing -> false
      const segmentingState: QuickEnrollState = {
        active: true,
        shots: [{ ...currentWithMask, status: 'segmenting' }],
        currentId: 's1',
      };
      expect(selectCanNext(segmentingState)).toBe(false);

      // no current -> false
      expect(selectCanNext({ active: true, shots: [] })).toBe(false);
    });

    it('selectReferences: shape and order of accepted shots', () => {
      const s1 = makeAcceptedShot(1);
      const s2 = makeAcceptedShot(2);
      const s3 = makeAcceptedShot(3);

      const state: QuickEnrollState = {
        active: true,
        shots: [s1, s2, s3],
      };

      expect(selectReferences(state)).toEqual([
        {
          image_id: 'img-1',
          cutout_image_id: 'cutout-1',
          bbox: [0, 0, 100, 100],
        },
        {
          image_id: 'img-2',
          cutout_image_id: 'cutout-2',
          bbox: [0, 0, 100, 100],
        },
        {
          image_id: 'img-3',
          cutout_image_id: 'cutout-3',
          bbox: [0, 0, 100, 100],
        },
      ]);
    });
  });

  describe('useQuickEnrollStore', () => {
    beforeEach(() => {
      useQuickEnrollStore.setState(initialQuickEnroll);
    });

    it('dispatches actions and updates store state', () => {
      expect(useQuickEnrollStore.getState().active).toBe(false);

      useQuickEnrollStore.getState().dispatch({ type: 'toggle' });
      expect(useQuickEnrollStore.getState().active).toBe(true);

      useQuickEnrollStore.getState().dispatch({
        type: 'captured',
        ...samplePhoto,
      });
      expect(useQuickEnrollStore.getState().shots).toHaveLength(1);
      expect(useQuickEnrollStore.getState().currentId).toBe(samplePhoto.id);

      useQuickEnrollStore.getState().dispatch({ type: 'retake' });
      expect(useQuickEnrollStore.getState().shots).toHaveLength(0);
      expect(useQuickEnrollStore.getState().currentId).toBeUndefined();
    });
  });
});

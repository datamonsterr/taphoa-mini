import {
  initialScanState,
  scanReducer,
  type ScanAction,
  type ScanState,
} from './scanReducer';
import { candidate, detection, scan } from './testing';

const photo = { uri: 'file:///p.jpg', width: 1080, height: 1440 };
const result = scan([
  detection('d1'),
  detection('d2'),
  detection('d3', { match: 'unknown', candidates: [candidate('u', 1, 0.3)] }),
  detection('d4', { match: 'ambiguous' }),
]);

function run(actions: ScanAction[], from: ScanState = initialScanState) {
  return actions.reduce(scanReducer, from);
}
const toResult = [
  { type: 'shutter', token: 1 },
  { type: 'captured', token: 1, photo },
  { type: 'scanned', token: 1, scan: result },
] as const satisfies ScanAction[];

describe('scanReducer', () => {
  it('starts idle and empty', () => {
    expect(initialScanState).toMatchObject({
      phase: 'idle',
      selected: {},
      chosen: {},
      openId: null,
    });
    expect(initialScanState.photo).toBeUndefined();
  });

  it('idle -> capturing -> scanning -> result', () => {
    expect(run([toResult[0]]).phase).toBe('capturing');
    const scanning = run([toResult[0], toResult[1]]);
    expect(scanning).toMatchObject({ phase: 'scanning', photo });
    const done = run(toResult);
    expect(done.phase).toBe('result');
    expect(done.scan).toBe(result);
  });

  it('selects every matched detection by default, never a low or ambiguous one', () => {
    expect(run(toResult).selected).toEqual({ d1: true, d2: true });
  });

  it('an ambiguous box can be selected by hand', () => {
    const picked = scanReducer(run(toResult), { type: 'toggle', id: 'd4' });
    expect(picked.selected.d4).toBe(true);
  });

  it('ignores actions that do not fit the phase', () => {
    expect(run([{ type: 'captured', token: 1, photo }])).toBe(initialScanState);
    expect(run([{ type: 'scanned', token: 1, scan: result }])).toBe(
      initialScanState,
    );
    const capturing = run([toResult[0]]);
    expect(scanReducer(capturing, toResult[0])).toBe(capturing);
    expect(scanReducer(capturing, { type: 'toggle', id: 'd1' })).toBe(
      capturing,
    );
    expect(scanReducer(capturing, { type: 'retry', token: 2 })).toBe(capturing);
    expect(
      scanReducer(initialScanState, { type: 'failed', token: 0, message: 'x' }),
    ).toBe(initialScanState);
  });

  it('ignores a late response from an older request', () => {
    const second = run([
      ...toResult,
      { type: 'reset' },
      { type: 'shutter', token: 2 },
      { type: 'captured', token: 2, photo },
    ]);
    expect(
      scanReducer(second, { type: 'scanned', token: 1, scan: result }),
    ).toBe(second);
    expect(
      scanReducer(second, { type: 'failed', token: 1, message: 'old' }),
    ).toBe(second);
    expect(scanReducer(second, { type: 'captured', token: 1, photo })).toBe(
      second,
    );
  });

  it('fails during capture without a photo, and during scanning with one', () => {
    const capture = run([
      toResult[0],
      { type: 'failed', token: 1, message: 'camera' },
    ]);
    expect(capture).toMatchObject({ phase: 'error', error: 'camera' });
    expect(capture.photo).toBeUndefined();
    const scanFail = run([
      toResult[0],
      toResult[1],
      { type: 'failed', token: 1, message: '503' },
    ]);
    expect(scanFail).toMatchObject({ phase: 'error', error: '503', photo });
  });

  it('retry moves an error with a photo back to scanning', () => {
    const failed = run([
      toResult[0],
      toResult[1],
      { type: 'failed', token: 1, message: '503' },
    ]);
    const retried = scanReducer(failed, { type: 'retry', token: 2 });
    expect(retried).toMatchObject({ phase: 'scanning', token: 2, photo });
    expect(retried.error).toBeUndefined();
    const noPhoto = run([
      toResult[0],
      { type: 'failed', token: 1, message: 'camera' },
    ]);
    expect(scanReducer(noPhoto, { type: 'retry', token: 2 })).toBe(noPhoto);
  });

  it('toggles a box on and off, but not a low match', () => {
    const done = run(toResult);
    const off = scanReducer(done, { type: 'toggle', id: 'd1' });
    expect(off.selected).toEqual({ d1: false, d2: true });
    expect(scanReducer(off, { type: 'toggle', id: 'd1' }).selected.d1).toBe(
      true,
    );
    expect(scanReducer(done, { type: 'toggle', id: 'd3' })).toBe(done);
    expect(scanReducer(done, { type: 'toggle', id: 'nope' })).toBe(done);
  });

  it('opens and closes the strip of one box at a time', () => {
    const done = run(toResult);
    const open = scanReducer(done, { type: 'toggleOpen', id: 'd1' });
    expect(open.openId).toBe('d1');
    expect(scanReducer(open, { type: 'toggleOpen', id: 'd2' }).openId).toBe(
      'd2',
    );
    expect(scanReducer(open, { type: 'toggleOpen', id: 'd1' }).openId).toBe(
      null,
    );
    expect(scanReducer(done, { type: 'toggleOpen', id: 'd3' })).toBe(done);
  });

  it('choosing an alternative replaces the product and selects the box', () => {
    const deselected = scanReducer(run(toResult), { type: 'toggle', id: 'd1' });
    const chosen = scanReducer(deselected, {
      type: 'choose',
      id: 'd1',
      productId: 'd1-b',
    });
    expect(chosen.chosen).toEqual({ d1: 'd1-b' });
    expect(chosen.selected.d1).toBe(true);
  });

  it('ignores a choice that is not a candidate of that box', () => {
    const done = run(toResult);
    expect(
      scanReducer(done, { type: 'choose', id: 'd1', productId: 'zzz' }),
    ).toBe(done);
    expect(
      scanReducer(done, { type: 'choose', id: 'nope', productId: 'd1-b' }),
    ).toBe(done);
  });

  describe('added', () => {
    it('keeps the low and ambiguous boxes on screen after adding the matched ones', () => {
      const done = run(toResult);
      const after = scanReducer(done, { type: 'added' });
      expect(after.phase).toBe('result');
      expect(after.photo).toBe(photo);
      expect(after.scan!.detections.map((d) => d.id)).toEqual(['d3', 'd4']);
      expect(after.selected).toEqual({});
      expect(after.openId).toBeNull();
    });

    it('drops a matched box the seller deselected', () => {
      const off = scanReducer(run(toResult), { type: 'toggle', id: 'd1' });
      const after = scanReducer(off, { type: 'added' });
      expect(after.scan!.detections.map((d) => d.id)).toEqual(['d3', 'd4']);
    });

    it('also removes an ambiguous box the seller selected', () => {
      const picked = scanReducer(run(toResult), { type: 'toggle', id: 'd4' });
      const after = scanReducer(picked, { type: 'added' });
      expect(after.scan!.detections.map((d) => d.id)).toEqual(['d3']);
    });

    it('resets to idle when nothing remains', () => {
      const only = scan([detection('d1')]);
      const done = run([
        toResult[0],
        toResult[1],
        { type: 'scanned', token: 1, scan: only },
      ]);
      const after = scanReducer(done, { type: 'added' });
      expect(after).toMatchObject({ phase: 'idle', selected: {} });
      expect(after.photo).toBeUndefined();
    });

    it('is ignored outside a result', () => {
      expect(scanReducer(initialScanState, { type: 'added' })).toBe(
        initialScanState,
      );
    });
  });

  it('reset returns to idle from any phase, dropping photo and results', () => {
    const open = scanReducer(run(toResult), { type: 'toggleOpen', id: 'd1' });
    const reset = scanReducer(open, { type: 'reset' });
    expect(reset).toMatchObject({ phase: 'idle', selected: {}, openId: null });
    expect(reset.photo).toBeUndefined();
    expect(reset.scan).toBeUndefined();
    expect(scanReducer(initialScanState, { type: 'reset' })).toBe(
      initialScanState,
    );
  });
});

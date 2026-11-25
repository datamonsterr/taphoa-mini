import { setAnalyticsSink } from '@/lib/analytics';

import {
  cancelOneTrip,
  centerPoint,
  finishOneTrip,
  markOneTripStart,
  oneTripEnabled,
  parseNamePrice,
} from './oneTrip';

describe('parseNamePrice', () => {
  it.each([
    ['mì hảo hảo năm nghìn', 'Mì hảo hảo', 5000],
    ['bánh bi giá mười lăm nghìn', 'Bánh bi', 15000],
    ['sữa vinamilk ba mươi lăm nghìn đồng', 'Sữa vinamilk', 35000],
    ['nước mắm nam ngư một trăm hai mươi nghìn', 'Nước mắm nam ngư', 120000],
    ['mì hảo hảo hai chục', 'Mì hảo hảo', 20000],
    ['kẹo bạc hà năm nghìn rưỡi', 'Kẹo bạc hà', 5500],
    ['dầu ăn mười hai ngàn', 'Dầu ăn', 12000],
    ['trà xanh 7 nghìn', 'Trà xanh', 7000],
    ['coca 12.000đ', 'Coca', 12000],
    ['bia sài gòn 15k', 'Bia sài gòn', 15000],
    ['gạo ST25 1 triệu rưỡi', 'Gạo ST25', 1_500_000],
    ['Pepsi 10000', 'Pepsi', 10000],
  ])('%s', (text, name, price) => {
    expect(parseNamePrice(text)).toEqual({ name, price });
  });

  it('keeps a trailing number without a scale in the name', () => {
    expect(parseNamePrice('coca 330')).toEqual({ name: 'Coca 330' });
    expect(parseNamePrice('bánh ba')).toEqual({ name: 'Bánh ba' });
  });

  it('returns a price alone when only a price is spoken', () => {
    expect(parseNamePrice('năm nghìn')).toEqual({ name: '', price: 5000 });
  });

  it('returns nothing for silence', () => {
    expect(parseNamePrice('  ')).toEqual({ name: '' });
  });
});

describe('oneTripEnabled', () => {
  const env = process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL;
  afterEach(() => {
    if (env === undefined) delete process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL;
    else process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL = env;
  });

  it('is off by default', () => {
    delete process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL;
    expect(oneTripEnabled(undefined)).toBe(false);
  });

  it('is on with the build flag', () => {
    process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL = '1';
    expect(oneTripEnabled(undefined)).toBe(true);
  });

  it('is on with the route param in development and e2e builds', () => {
    delete process.env.EXPO_PUBLIC_ONE_TRIP_ENROLL;
    expect(oneTripEnabled('1')).toBe(true);
    expect(oneTripEnabled('0')).toBe(false);
  });
});

it('prompts the centre of the photo', () => {
  expect(centerPoint(1024, 768)).toEqual({ x: 512, y: 384, label: 1 });
});

describe('one-trip timing', () => {
  const events: { event: string; props: unknown }[] = [];
  beforeEach(() => {
    events.length = 0;
    setAnalyticsSink({
      capture: (event, props) => events.push({ event, props }),
    });
  });
  afterEach(() => {
    setAnalyticsSink(null);
    jest.restoreAllMocks();
  });

  it('logs the time from the first shutter press to the saved product', () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    markOneTripStart();
    now.mockReturnValue(13_400.4);
    finishOneTrip({ shot_count: 3, voice_used: true });
    const props = { duration_ms: 12_400, shot_count: 3, voice_used: true };
    expect(info).toHaveBeenCalledWith('enroll.one_trip_completed', props);
    expect(events).toEqual([{ event: 'one_trip_enrollment_completed', props }]);
    // A second save without a new start logs nothing.
    finishOneTrip({ shot_count: 3, voice_used: true });
    expect(events).toHaveLength(1);
  });

  it('logs nothing after a cancel', () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    markOneTripStart();
    cancelOneTrip();
    finishOneTrip({ shot_count: 3, voice_used: false });
    expect(events).toEqual([]);
  });
});

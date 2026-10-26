import { t } from '@/lib/i18n';

import { dict } from './strings';

test('vi and en define the same keys', () => {
  expect(Object.keys(dict.en).sort()).toEqual(Object.keys(dict.vi).sort());
});

test('Vietnamese is the default and carries the required labels', () => {
  expect(t(dict, 'title')).toBe('Trợ lý');
  expect(t(dict, 'title', 'en')).toBe('Assistant');
  expect(t(dict, 'viewAsTable')).toBe('Xem dạng bảng');
  expect(t(dict, 'viewAsTable', 'en')).toBe('View as table');
});

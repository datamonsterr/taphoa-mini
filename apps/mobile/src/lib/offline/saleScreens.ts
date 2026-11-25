import { scanFromURLAsync } from 'expo-camera';
import { Platform } from 'react-native';

import { BARCODE_SETTINGS } from '@/features/camera/barcode';

/** A 1x1 white PNG: decoding it loads the scanner without a network request of its own. */
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/**
 * Code a grid sale needs. On web every route is its own chunk, so they are fetched while the
 * network is up; offline, opening the cart or the pay screen would otherwise fail to load. Only
 * the module is loaded: `router.prefetch` would also mount the screen in the stack, leaving a
 * second cart and pay screen behind the real one.
 *
 * The pay screen returns to the camera, whose live barcode scan on web loads a polyfill chunk and
 * its ZXing WebAssembly (from a CDN) on the first frame, when the browser has no native
 * BarcodeDetector. One scan of a blank image while online loads both, so a camera first opened
 * offline still scans instead of failing to fetch them.
 */
export function prefetchSaleScreens() {
  for (const load of [() => import('@/app/cart'), () => import('@/app/pay')])
    load().catch(() => undefined);
  if (Platform.OS === 'web')
    scanFromURLAsync(BLANK_PNG, BARCODE_SETTINGS.barcodeTypes).catch(
      () => undefined,
    );
}

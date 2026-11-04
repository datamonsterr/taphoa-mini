import { router, useIsFocused } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { CameraScreen } from '@/features/camera/CameraScreen';
import { SyncStatus } from './SyncStatus';
import { useSettingsStore } from '@/stores/settings';

/** Whether the app already chose its start screen since launch. */
let startChosen = false;

/** Test hook: forget the launch so the next `Home` mount chooses again. */
export function resetStartRoute() {
  startChosen = false;
}

const subscribeHydration = (notify: () => void) =>
  useSettingsStore.persist.onFinishHydration(notify);
const settingsHydrated = () => useSettingsStore.persist.hasHydrated();

/**
 * The `/` route. Normally the camera. In elder mode (T2) the app opens on the sell grid
 * (Kho) once per launch: the camera stays unmounted until the seller comes back to it.
 */
export function Home() {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    settingsHydrated,
    settingsHydrated,
  );
  const focused = useIsFocused();
  const [mode, setMode] = useState<'pending' | 'camera' | 'grid'>(() =>
    startChosen ? 'camera' : 'pending',
  );
  const [cameFromGrid, setCameFromGrid] = useState(false);

  // Derived from the stored setting as soon as it has loaded (adjusting state while rendering).
  if (mode === 'pending' && hydrated) {
    setMode(useSettingsStore.getState().elderMode ? 'grid' : 'camera');
  }
  if (mode === 'grid' && !focused && !cameFromGrid) setCameFromGrid(true);

  useEffect(() => {
    if (mode === 'pending') return;
    startChosen = true;
    if (mode === 'grid') router.push('/inventory');
  }, [mode]);

  if (mode === 'pending') return null;
  if (mode === 'grid' && !(cameFromGrid && focused)) return null;
  return (
    <>
      <CameraScreen />
      <SyncStatus />
    </>
  );
}

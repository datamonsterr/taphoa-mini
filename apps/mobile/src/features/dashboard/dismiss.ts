import { router } from 'expo-router';

/** Close a sheet route: go back, or land on the dashboard when it was opened directly. */
export function dismissSheet(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/dashboard');
}

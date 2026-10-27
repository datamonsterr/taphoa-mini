import { useCaptureModeStore } from '@/features/camera/modeStore';
import {
  initialQuickEnroll,
  useQuickEnrollStore,
} from '@/features/camera/quickEnroll';
import { useInviteIntent } from '@/features/onboarding/inviteIntent';
import { useReceiptNotice } from '@/features/receipts/ReceiptToast';
import { useCartStore } from '@/stores/cart';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';

/**
 * Client state that belongs to one person in one store, so a different person or store must not
 * inherit it. React Query is cleared by the caller. Device-wide preferences stay: settings, the
 * selected stores (`currentStore`), the device lock, the tab bar chrome and the half-typed email
 * of a sign-in (reset by its own flows). Add every new store with store-scoped data here.
 */
export function resetStoreScopedState() {
  useCartStore.getState().clear();
  useLowStockAlerts.getState().reset();
  // Photos, server image ids and cut-outs of the product being enrolled.
  useQuickEnrollStore.setState(initialQuickEnroll);
  useReceiptNotice.setState({ count: null });
  useCaptureModeStore.setState({ mode: 'one' });
}

/**
 * What belongs to the previous person alone, on top of the store scope: a join link they opened.
 * The caller keeps it when nobody was signed in before (a link opened signed out is for whoever
 * signs in next).
 */
export function resetPersonScopedState() {
  useInviteIntent.getState().setToken('');
}

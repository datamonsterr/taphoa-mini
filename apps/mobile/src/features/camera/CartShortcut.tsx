import { memo } from 'react';

import { CartPill } from '@/components/camera';
import { selectCount, selectTotal, useCartStore } from '@/stores/cart';

import { CartPop } from './AddFeedback';

/**
 * Owns the cart subscription so an add or a quantity change re-renders only the pill, never the
 * viewfinder, the shutter or the detection boxes in `CameraScreen`.
 */
export const CartShortcut = memo(function CartShortcut({
  onPress,
}: {
  onPress: () => void;
}) {
  const count = useCartStore(selectCount);
  const total = useCartStore(selectTotal);
  return (
    <CartPop count={count}>
      <CartPill count={count} total={total} onPress={onPress} />
    </CartPop>
  );
});

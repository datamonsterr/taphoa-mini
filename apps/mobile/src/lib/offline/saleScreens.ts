/**
 * Screens a grid sale needs. On web every route is its own chunk, so they are fetched while the
 * network is up; offline, opening the cart or the pay screen would otherwise fail to load. Only
 * the module is loaded: `router.prefetch` would also mount the screen in the stack, leaving a
 * second cart and pay screen behind the real one.
 */
export function prefetchSaleScreens() {
  for (const load of [() => import('@/app/cart'), () => import('@/app/pay')])
    load().catch(() => undefined);
}

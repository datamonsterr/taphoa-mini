import product from './product-overview.mjs';
import activation from './activation-funnel.mjs';
import checkout from './checkout-recognition.mjs';
import receipts from './receipts-stock.mjs';
import assistant from './assistant-adoption.mjs';
import debt from './debt-book.mjs';
import reliability from './reliability.mjs';
export const dashboards = [
  product,
  activation,
  checkout,
  receipts,
  assistant,
  debt,
  reliability,
];
export { default as playlists } from './playlists.mjs';
export { default as featureFlags } from './feature-flags.mjs';
export { default as logViews } from './log-views.mjs';
export { default as groupTypes } from './group-types.mjs';
export { default as projectSettings } from './project-settings.mjs';

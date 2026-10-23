/// <reference path="../../node_modules/expo-router/build/ts-declarations/expect.d.ts" />
import { renderRouter } from 'expo-router/testing-library';
import path from 'node:path';

/**
 * Renders the real `src/app` route tree (root layout, providers, fonts, stack) at `initialUrl`.
 * The root layout owns the query client, so every call starts with an empty cache.
 */
export async function renderApp(initialUrl = '/') {
  return renderRouter(path.resolve(__dirname, '../app'), { initialUrl });
}

export {
  act,
  fireEvent,
  screen,
  testRouter,
  waitFor,
  within,
} from 'expo-router/testing-library';

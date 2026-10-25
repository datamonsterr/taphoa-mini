import type { MobileStoreEvent } from '@/lib/api/events';

let events: MobileStoreEvent[] = [];

/** Events emitted by mock transactions, in delivery order. */
export const getMockEvents = (): readonly MobileStoreEvent[] => events;
export const emitMockEvent = (event: MobileStoreEvent): void => {
  events.push(event);
};
export const resetMockEvents = (): void => {
  events = [];
};

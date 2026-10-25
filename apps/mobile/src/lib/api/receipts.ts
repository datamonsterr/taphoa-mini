import { newUuid } from '@/lib/uuid';

import { getApiClient } from './client';
import { unwrap } from './errors';
import { cursorQuery, type CursorParams } from './stock';
import type {
  Page,
  Receipt,
  ReceiptSummary,
  ReceiptCreate,
  ReceiptConfirm,
} from './types';

export type ReceiptStatus = Receipt['status'];

export const createReceipt = (
  body: ReceiptCreate,
  idempotencyKey = newUuid(),
): Promise<Receipt> =>
  unwrap(
    getApiClient().raw.POST('/v1/receipts', {
      body,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    }),
  );

export const listReceipts = (
  params: CursorParams & { status?: ReceiptStatus } = {},
): Promise<Page<ReceiptSummary>> =>
  unwrap(
    getApiClient().raw.GET('/v1/receipts', {
      params: { query: cursorQuery(params) },
    }),
  );

export const getReceipt = (receiptId: string): Promise<Receipt> =>
  unwrap(
    getApiClient().raw.GET('/v1/receipts/{receiptId}', {
      params: { path: { receiptId } },
    }),
  );

export const confirmReceipt = (
  receiptId: string,
  body: ReceiptConfirm,
  idempotencyKey = newUuid(),
): Promise<Receipt> =>
  unwrap(
    getApiClient().raw.POST('/v1/receipts/{receiptId}/confirm', {
      params: {
        path: { receiptId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }),
  );

export const discardReceipt = (receiptId: string): Promise<void> =>
  unwrap(
    getApiClient().raw.DELETE('/v1/receipts/{receiptId}', {
      params: { path: { receiptId } },
    }),
  );

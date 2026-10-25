import type { paths } from '@taphoa/api-client';
import { newUuid } from '@/lib/uuid';
import { getApiClient } from './client';
import { unwrap } from './errors';
import type {
  Customer,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  DebtEntry,
  CreateRepaymentRequest,
  CreateDebtAdjustmentRequest,
  DebtSummary,
} from './types';

export type ListCustomersParams = NonNullable<
  paths['/v1/customers']['get']['parameters']['query']
>;
export type DebtPageParams = NonNullable<
  paths['/v1/customers/{customerId}/entries']['get']['parameters']['query']
>;
export const listCustomers = (params: ListCustomersParams = {}) =>
  unwrap(
    getApiClient().raw.GET('/v1/customers', { params: { query: params } }),
  );
export const createCustomer = (
  input: Omit<CreateCustomerRequest, 'id'> & { id?: string },
): Promise<Customer> =>
  unwrap(
    getApiClient().raw.POST('/v1/customers', {
      body: { ...input, id: input.id ?? newUuid() },
    }),
  );
export const getCustomer = (customerId: string): Promise<Customer> =>
  unwrap(
    getApiClient().raw.GET('/v1/customers/{customerId}', {
      params: { path: { customerId } },
    }),
  );
export const updateCustomer = (
  customerId: string,
  body: UpdateCustomerRequest,
): Promise<Customer> =>
  unwrap(
    getApiClient().raw.PATCH('/v1/customers/{customerId}', {
      params: { path: { customerId } },
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body,
    }),
  );
export const listDebtEntries = (
  customerId: string,
  params: DebtPageParams = {},
) =>
  unwrap(
    getApiClient().raw.GET('/v1/customers/{customerId}/entries', {
      params: { path: { customerId }, query: params },
    }),
  );
export const createRepayment = (
  customerId: string,
  body: CreateRepaymentRequest,
  idempotencyKey: string,
): Promise<DebtEntry> =>
  unwrap(
    getApiClient().raw.POST('/v1/customers/{customerId}/repayments', {
      params: {
        path: { customerId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }),
  );
export const createDebtAdjustment = (
  customerId: string,
  body: CreateDebtAdjustmentRequest,
  idempotencyKey: string,
): Promise<DebtEntry> =>
  unwrap(
    getApiClient().raw.POST('/v1/customers/{customerId}/adjustments', {
      params: {
        path: { customerId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }),
  );
export const getDebtSummary = (): Promise<DebtSummary> =>
  unwrap(getApiClient().raw.GET('/v1/debts/summary'));

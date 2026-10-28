import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ExportTransactionsQuery,
  VoidSaleInput,
} from '@taphoa/api-client';
import { getApiClient } from './client';
import { unwrap } from './errors';
import { keys } from './keys';
import { listSales } from './ledger';

export const getSale = (id: string) => unwrap(getApiClient().getSale(id));
export const voidSale = (id: string, body: VoidSaleInput) =>
  unwrap(getApiClient().voidSale(id, body));
export const exportTransactions = (query: ExportTransactionsQuery) =>
  unwrap(getApiClient().exportTransactions(query));

export function useRecentSales() {
  return useInfiniteQuery({
    queryKey: [...keys.sales.all(), 'recent'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listSales({ limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}
export function useSale(id: string) {
  return useQuery({
    queryKey: [...keys.sales.all(), 'detail', id],
    queryFn: () => getSale(id),
    enabled: Boolean(id),
  });
}
export function useVoidSale(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VoidSaleInput) => voidSale(id, body),
    onSuccess: async (sale) => {
      qc.setQueryData([...keys.sales.all(), 'detail', id], sale);
      // Full void affects cash, stock and (for credit sales) the customer's debt.
      await Promise.all(
        [
          keys.sales.all(),
          keys.reports.all(),
          keys.products.all(),
          keys.stock.all(),
          [...keys.all, 'stock-movements'],
          keys.customers.all(),
          keys.debtEntries.all(),
          keys.debtSummary(),
          [...keys.all, 'digest'],
        ].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
    },
  });
}

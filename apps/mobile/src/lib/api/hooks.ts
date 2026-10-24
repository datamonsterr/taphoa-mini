import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';

import { addDays, businessDate, startOfWeek, subMonths } from '@/lib/date';

import {
  acceptAlert,
  createDayClose,
  createExpense,
  createSale,
  dismissAlert,
  getDayClose,
  getReportSummary,
  getTodayReport,
  listAlerts,
  listExpenses,
  listSales,
} from './ledger';
import { setPin, switchMember } from './auth';
import { isApiError } from './errors';
import {
  createScan,
  segmentPoints,
  uploadImage,
  type CreateScanInput,
} from './images';
import { keys } from './keys';
import { fillSummaryBuckets } from './summary';
import { applyOptimisticPrice } from './optimisticPrice';
import { listManualLines, resolveManualLine } from './review';
import {
  addProductImage,
  createProduct,
  getProduct,
  listCategories,
  listProducts,
  patchProduct,
  type ListProductsParams,
} from './products';
import {
  createInvite,
  getMe,
  getStore,
  listMembers,
  patchStore,
} from './store';
import type {
  AlertStatus,
  CreateExpenseRequest,
  ImagePurpose,
  Product,
  ProductIndexStatus,
  ProductPatch,
  ReportPeriod,
  ManualLineStatus,
  Page,
  ResolveManualLineInput,
  Sale,
  SegmentPointsRequest,
  StorePatch,
  UploadFile,
} from './types';

const SALES_PAGE_SIZE = 200;

const invalidate = (qc: QueryClient, ...queryKeys: (readonly unknown[])[]) =>
  Promise.all(queryKeys.map((queryKey) => qc.invalidateQueries({ queryKey })));

// ---- queries --------------------------------------------------------------

export const useMe = () => useQuery({ queryKey: keys.me(), queryFn: getMe });

export const useStore = () =>
  useQuery({ queryKey: keys.store(), queryFn: getStore });

export const useMembers = () =>
  useQuery({ queryKey: keys.members(), queryFn: listMembers });

export const useCategories = () =>
  useQuery({ queryKey: keys.categories(), queryFn: listCategories });

const productsQuery = (params: Omit<ListProductsParams, 'cursor'>) => ({
  queryKey: keys.products.list(params),
  queryFn: ({ pageParam }: { pageParam: string | null }) =>
    listProducts({ ...params, cursor: pageParam }),
  initialPageParam: null as string | null,
  getNextPageParam: (last: { next_cursor: string | null }) => last.next_cursor,
});

/** Products matching `params` (e.g. `{ q }`), flattened across cursor pages. */
export function useProducts(params: Omit<ListProductsParams, 'cursor'> = {}) {
  return useInfiniteQuery({
    ...productsQuery(params),
    // Typing a search keeps the previous grid on screen until the new page arrives.
    placeholderData: keepPreviousData,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export const useProduct = (id: string | undefined) =>
  useQuery({
    queryKey: keys.products.detail(id ?? ''),
    queryFn: () => getProduct(id!),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.index_status === 'pending' ? 2000 : false,
  });

export const useSales = (params: Parameters<typeof listSales>[0] = {}) =>
  useQuery({
    queryKey: keys.sales.list(params),
    queryFn: () => listSales(params),
  });

/** Every sale of a range: pages are followed until the server has no `next_cursor`. */
export const useAllSales = (
  params: Omit<Parameters<typeof listSales>[0], 'cursor' | 'limit'> = {},
  enabled = true,
) =>
  useQuery({
    queryKey: keys.sales.every(params),
    enabled,
    queryFn: async () => {
      const items: Sale[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<Sale> = await listSales({
          ...params,
          limit: SALES_PAGE_SIZE,
          cursor,
        });
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    },
  });

export const useExpenses = (params: Parameters<typeof listExpenses>[0] = {}) =>
  useQuery({
    queryKey: keys.expenses.list(params),
    queryFn: () => listExpenses(params),
  });

export const useManualLines = (
  status: ManualLineStatus = 'open',
  enabled = true,
) =>
  useQuery({
    queryKey: keys.manualLines.list(status),
    queryFn: () => listManualLines({ status }),
    enabled,
  });

export const useAlerts = (status: AlertStatus = 'open', enabled = true) =>
  useQuery({
    queryKey: keys.alerts.list(status),
    queryFn: () => listAlerts(status),
    enabled,
  });

export const useTodayReport = (date?: string) =>
  useQuery({
    queryKey: keys.reports.today(date),
    queryFn: () => getTodayReport(date),
  });

/** Date range and bucket size behind the day / week / month bars of the report screen. */
export function summaryRange(period: ReportPeriod, now: Date = new Date()) {
  const today = businessDate(now);
  switch (period) {
    case 'day':
      return {
        from: addDays(today, -6),
        to: today,
        granularity: 'day' as const,
      };
    case 'week':
      return {
        from: startOfWeek(addDays(today, -35)),
        to: today,
        granularity: 'week' as const,
      };
    case 'month':
      return {
        from: subMonths(today, 5),
        to: today,
        granularity: 'month' as const,
      };
  }
}

/** `date` (YYYY-MM-DD) is part of the key, so the ranges move on at midnight. */
export const useReportSummary = (
  period: ReportPeriod,
  date: string = businessDate(),
) =>
  useQuery({
    queryKey: keys.reports.summary(period, date),
    queryFn: () => getReportSummary(summaryRange(period, new Date(date))),
    // The server lists only buckets with activity; the chart needs every day/week/month.
    select: (report) =>
      fillSummaryBuckets(report, summaryRange(period, new Date(date))),
  });

/** Day close of a business date; `null` when the day is not closed yet (404). */
export const useDayClose = (date: string) =>
  useQuery({
    queryKey: keys.reports.dayClose(date),
    queryFn: async () => {
      try {
        return await getDayClose(date);
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });

// ---- mutations ------------------------------------------------------------

export function useCreateScan() {
  return useMutation({
    mutationFn: (input: CreateScanInput) => createScan(input),
  });
}

export function useUploadImage() {
  return useMutation({
    mutationFn: (input: { file: UploadFile; purpose?: ImagePurpose }) =>
      uploadImage(input.file, input.purpose),
  });
}

export function useSegmentPoints() {
  return useMutation({
    mutationFn: (body: SegmentPointsRequest) => segmentPoints(body),
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createProduct,
    // `from_manual_line_id` resolves a flagged line, so the review list and reports move too.
    onSuccess: () =>
      invalidate(
        qc,
        keys.products.all(),
        keys.manualLines.all(),
        keys.reports.all(),
      ),
  });
}

/**
 * A price edit shows at once in the cached detail and lists. The rollback and the refetch live
 * here, not in the screen's `mutate` callbacks, so they still run after the screen unmounted.
 */
export function usePatchProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: ProductPatch }) =>
      patchProduct(input.id, input.patch),
    onMutate: async (input): Promise<{ rollback?: () => void }> =>
      input.patch.price === undefined
        ? {}
        : {
            rollback: await applyOptimisticPrice(
              qc,
              input.id,
              input.patch.price,
            ),
          },
    onError: (_error, _input, context) => context?.rollback?.(),
    onSettled: () => invalidate(qc, keys.products.all(), keys.alerts.all()),
  });
}

export function useAddProductImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      image_id: string;
      detection_id?: string;
    }) =>
      addProductImage(input.id, {
        image_id: input.image_id,
        detection_id: input.detection_id,
      }),
    onSuccess: () => invalidate(qc, keys.products.all()),
  });
}

/** A sale changes the reports, the stock shown on products and the margin alerts. */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSale,
    onSuccess: () =>
      invalidate(
        qc,
        keys.sales.all(),
        keys.manualLines.all(),
        keys.reports.all(),
        keys.products.all(),
        keys.alerts.all(),
      ),
  });
}

/** An expense changes the reports; purchase lines also move cost, stock and alerts. */
export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExpenseRequest) => createExpense(body),
    onSuccess: (_expense, body) =>
      invalidate(
        qc,
        keys.expenses.all(),
        keys.reports.all(),
        ...(body.purchase_lines?.length
          ? [keys.products.all(), keys.alerts.all()]
          : []),
      ),
  });
}

/** Link, enrol or dismiss a hand-priced sale line. */
export function useResolveManualLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { lineId: string } & ResolveManualLineInput) =>
      resolveManualLine(input.lineId, {
        action: input.action,
        ...(input.product_id ? { product_id: input.product_id } : {}),
      }),
    onSuccess: () =>
      invalidate(
        qc,
        keys.manualLines.all(),
        keys.reports.all(),
        keys.products.all(),
      ),
  });
}

export function useAcceptAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; new_price?: number }) =>
      acceptAlert(input.id, input.new_price),
    onSuccess: () => invalidate(qc, keys.alerts.all(), keys.products.all()),
  });
}

export function useDismissAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: dismissAlert,
    onSuccess: () => invalidate(qc, keys.alerts.all()),
  });
}

export function useCreateDayClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      date: string;
      counted_cash: number;
      opening_float?: number;
      note?: string;
    }) =>
      createDayClose(input.date, {
        counted_cash: input.counted_cash,
        opening_float: input.opening_float,
        note: input.note,
      }),
    onSuccess: () => invalidate(qc, keys.reports.all()),
  });
}

export function usePatchStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: StorePatch) => patchStore(patch),
    onSuccess: () => invalidate(qc, keys.store(), keys.me(), keys.alerts.all()),
  });
}

/** The phone acts as another member: everything cached belonged to the previous one. */
export function useSwitchMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof switchMember>[0]) =>
      switchMember(input),
    onSuccess: () => qc.resetQueries({ queryKey: keys.all }),
  });
}

export function useSetPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pin: string | null) => setPin(pin),
    onSuccess: () => invalidate(qc, keys.members(), keys.me()),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createInvite,
    onSuccess: () => invalidate(qc, keys.members()),
  });
}

// ---- event helpers --------------------------------------------------------

type CachedProductData = Product | InfiniteData<Page<Product>> | Page<Product>;

const withIndexStatus =
  (id: string, indexStatus: ProductIndexStatus) =>
  (old: CachedProductData | undefined) => {
    if (!old) return old;
    if ('pages' in old) {
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === id ? { ...item, index_status: indexStatus } : item,
          ),
        })),
      };
    }
    if ('items' in old) {
      return {
        ...old,
        items: old.items.map((item) =>
          item.id === id ? { ...item, index_status: indexStatus } : item,
        ),
      };
    }
    if ('id' in old && old.id === id) {
      return { ...old, index_status: indexStatus };
    }
    return old;
  };

/**
 * Pure helper for the `product.indexed` outbox event.
 * Patches the cached product detail (keys.product(id)) and product lists' item index_status.
 */
export function applyProductIndexed(
  queryClient: QueryClient,
  data: {
    product_id: string;
    index_status: ProductIndexStatus;
    reference_count?: number;
  },
): void {
  queryClient.setQueriesData<CachedProductData>(
    { queryKey: keys.products.all() },
    withIndexStatus(data.product_id, data.index_status),
  );
}

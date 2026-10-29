import type {
  VoiceDraftLine,
  VoiceOutcomeRequest,
  VoiceSaleDraft,
} from '@taphoa/api-client';

import type { CreateSaleRequest, Customer, SaleLineInput } from '@/lib/api';
import type { NewCartLine } from '@/stores/cart';

export type DraftPayment = 'cash' | 'transfer' | 'credit';
export type LineStatus = 'matched' | 'ambiguous' | 'unknown';

/** The part of a catalog product the draft needs. */
export type DraftProduct = {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
};

export type DraftLine = {
  /** Reused as the sale line id. */
  id: string;
  utteranceId: string;
  spoken: string;
  status: LineStatus;
  product: DraftProduct | null;
  /** Up to three look-alikes for an ambiguous line. */
  candidates: DraftProduct[];
  unitId: string | null;
  quantity: number;
  unitPrice: number | null;
  priceSource: 'spoken' | 'catalog' | 'none';
  priceMismatch: boolean;
  removed: boolean;
  /** What the server proposed, for the corrections sent back. */
  original: {
    productId: string | null;
    quantity: number;
    unitPrice: number | null;
  };
};

export type Draft = {
  lines: DraftLine[];
  paymentMethod: DraftPayment;
  customer: Customer | null;
  /** Name the seller said for a credit sale, when the server did not match one customer. */
  spokenCustomer: string | null;
  initial: { paymentMethod: DraftPayment; customerId: string | null };
};

const MAX_QUANTITY = 999;

type Summary = NonNullable<VoiceDraftLine['product']>;

const toProduct = (summary: Summary): DraftProduct => ({
  id: summary.id,
  name: summary.name ?? '',
  price: summary.price,
  ...(summary.image_url ? { imageUrl: summary.image_url } : {}),
});

function fromServerLine(line: VoiceDraftLine, utteranceId: string): DraftLine {
  const product = line.product ? toProduct(line.product) : null;
  const unitPrice = line.unit_price ?? null;
  return {
    id: line.id,
    utteranceId,
    spoken: line.spoken,
    status: line.status,
    product,
    candidates: (line.candidates ?? []).map(toProduct),
    unitId: line.unit_id ?? null,
    quantity: line.quantity,
    unitPrice,
    priceSource: line.price_source ?? 'none',
    priceMismatch: line.price_mismatch ?? false,
    removed: false,
    original: {
      productId: product?.id ?? null,
      quantity: line.quantity,
      unitPrice,
    },
  };
}

export function fromServerDraft(
  draft: VoiceSaleDraft,
  utteranceId: string,
): Draft {
  const customer =
    draft.customer?.status === 'matched'
      ? (draft.customer.customer ?? null)
      : null;
  return {
    lines: draft.lines.map((line) => fromServerLine(line, utteranceId)),
    paymentMethod: draft.payment_method,
    customer,
    spokenCustomer: draft.customer?.spoken_name ?? null,
    initial: {
      paymentMethod: draft.payment_method,
      customerId: customer?.id ?? null,
    },
  };
}

export type DraftAction =
  | { type: 'increment' | 'decrement' | 'remove'; id: string }
  | { type: 'pick'; id: string; productId: string }
  | { type: 'resolve'; id: string; product: DraftProduct }
  | { type: 'price'; id: string; price: number }
  | { type: 'payment'; method: DraftPayment }
  | { type: 'customer'; customer: Customer | null }
  | { type: 'append'; draft: Draft };

const mapLine = (
  draft: Draft,
  id: string,
  change: (l: DraftLine) => DraftLine,
): Draft => ({
  ...draft,
  lines: draft.lines.map((line) => (line.id === id ? change(line) : line)),
});

/** A catalog product put on a line: the price follows the catalog unless the seller said one. */
function withProduct(
  line: DraftLine,
  product: DraftProduct,
  status: LineStatus,
): DraftLine {
  const keepSpoken = line.priceSource === 'spoken' && line.unitPrice !== null;
  const unitPrice = keepSpoken ? line.unitPrice : product.price;
  return {
    ...line,
    status,
    product,
    unitPrice,
    priceSource: keepSpoken ? 'spoken' : 'catalog',
    priceMismatch: keepSpoken && unitPrice !== product.price,
    // The server picked the unit for the first product only.
    unitId: product.id === line.original.productId ? line.unitId : null,
  };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'increment':
      return mapLine(draft, action.id, (l) => ({
        ...l,
        quantity: Math.min(MAX_QUANTITY, l.quantity + 1),
      }));
    case 'decrement':
      return mapLine(draft, action.id, (l) => ({
        ...l,
        quantity: Math.max(1, l.quantity - 1),
      }));
    case 'remove':
      return mapLine(draft, action.id, (l) => ({ ...l, removed: true }));
    case 'pick':
      return mapLine(draft, action.id, (l) => {
        const product = l.candidates.find((c) => c.id === action.productId);
        return product ? withProduct(l, product, 'matched') : l;
      });
    case 'resolve':
      return mapLine(draft, action.id, (l) =>
        withProduct(l, action.product, 'matched'),
      );
    case 'price':
      return mapLine(draft, action.id, (l) => ({
        ...l,
        unitPrice: action.price,
        priceSource: 'spoken',
        priceMismatch: false,
      }));
    case 'payment':
      return { ...draft, paymentMethod: action.method };
    case 'customer':
      return { ...draft, customer: action.customer };
    case 'append':
      return {
        ...draft,
        lines: [...draft.lines, ...action.draft.lines],
        customer: draft.customer ?? action.draft.customer,
        spokenCustomer: draft.spokenCustomer ?? action.draft.spokenCustomer,
      };
  }
}

export const activeLines = (draft: Draft) =>
  draft.lines.filter((l) => !l.removed);

export const lineTotal = (line: DraftLine) =>
  line.quantity * (line.unitPrice ?? 0);

export const draftTotal = (draft: Draft) =>
  activeLines(draft).reduce((sum, line) => sum + lineTotal(line), 0);

export const itemCount = (draft: Draft) =>
  activeLines(draft).reduce((sum, line) => sum + line.quantity, 0);

type Correction = NonNullable<VoiceOutcomeRequest['corrections']>[number];

function correctionOf(line: DraftLine): Correction | null {
  if (line.removed) return { line_id: line.id, removed: true };
  const correction: Correction = { line_id: line.id };
  if (line.product && line.product.id !== line.original.productId)
    correction.chosen_product_id = line.product.id;
  if (line.quantity !== line.original.quantity)
    correction.quantity = line.quantity;
  if (line.unitPrice !== null && line.unitPrice !== line.original.unitPrice)
    correction.unit_price = line.unitPrice;
  return Object.keys(correction).length > 1 ? correction : null;
}

/** Corrections per utterance id: each outcome only names lines its own utterance proposed. */
export function correctionsByUtterance(
  draft: Draft,
): Map<string, Correction[]> {
  const byUtterance = new Map<string, Correction[]>();
  for (const line of draft.lines) {
    const list = byUtterance.get(line.utteranceId) ?? [];
    const correction = correctionOf(line);
    if (correction) list.push(correction);
    byUtterance.set(line.utteranceId, list);
  }
  return byUtterance;
}

/** True when the seller changed anything the model proposed. */
export const isEdited = (draft: Draft) =>
  [...correctionsByUtterance(draft).values()].some((list) => list.length > 0) ||
  draft.paymentMethod !== draft.initial.paymentMethod ||
  (draft.customer?.id ?? null) !== draft.initial.customerId;

export type Blocker = 'empty' | 'price' | 'customer' | 'unknown';

/** Why the green check is disabled, or null when the sale can go. */
export function blocker(draft: Draft): Blocker | null {
  const lines = activeLines(draft);
  if (lines.length === 0) return 'empty';
  if (lines.some((l) => l.unitPrice === null)) return 'price';
  if (draft.paymentMethod === 'credit' && !draft.customer) return 'customer';
  // The cart holds catalog products only, so a transfer needs every line matched.
  if (draft.paymentMethod === 'transfer' && lines.some((l) => !l.product))
    return 'unknown';
  return null;
}

export function saleLines(draft: Draft): SaleLineInput[] {
  return activeLines(draft).map((line): SaleLineInput => {
    const base = {
      id: line.id,
      quantity: line.quantity,
      unit_price: line.unitPrice ?? 0,
    };
    if (!line.product)
      return {
        ...base,
        source: 'manual',
        manual_label: line.spoken.slice(0, 80),
      };
    return {
      ...base,
      source: 'voice',
      product_id: line.product.id,
      ...(line.unitId ? { unit_id: line.unitId } : {}),
    };
  });
}

/** The cash or credit sale (transfer goes through the cart and the pay screen instead). */
export function saleRequest(
  draft: Draft,
  saleId: string,
  soldAt: string,
): CreateSaleRequest {
  const total = draftTotal(draft);
  const lines = saleLines(draft);
  if (draft.paymentMethod === 'credit' && draft.customer)
    return {
      id: saleId,
      sold_at: soldAt,
      payment_method: 'credit',
      credit: { customer_id: draft.customer.id, amount: total },
      total,
      lines,
    };
  return {
    id: saleId,
    sold_at: soldAt,
    payment_method: 'cash',
    cash_received: total,
    total,
    lines,
  };
}

/** Lines for the cart (transfer path); lines without a catalog product cannot go in. */
export function cartLines(draft: Draft): (NewCartLine & { qty: number })[] {
  return activeLines(draft).flatMap((line) =>
    line.product
      ? [
          {
            productId: line.product.id,
            name: line.product.name,
            price: line.unitPrice ?? line.product.price,
            qty: line.quantity,
            ...(line.product.imageUrl
              ? { imageUrl: line.product.imageUrl }
              : {}),
            source: 'voice' as const,
          },
        ]
      : [],
  );
}

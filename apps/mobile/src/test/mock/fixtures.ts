import { addDays, businessDate } from '@/lib/date';
import type {
  Customer,
  DebtEntry,
  Receipt,
  StockMovement,
  Category,
  DayClose,
  Expense,
  ExpenseCategory,
  Image,
  ManualLine,
  Member,
  PaymentMethod,
  Product,
  ProductImage,
  Sale,
  SaleLine,
  Scan,
  Store,
  MarginAlert,
} from '@/lib/api/types';

import { productImageUri, type ProductImageSlug } from './assets';
import { randomCode, seedUuid } from './ids';

export type ProductRecord = { product: Product };

export type MockState = {
  customers: Customer[];
  debtEntries: DebtEntry[];
  documentImageIds: Set<string>;
  stockMovements: Map<string, StockMovement[]>;
  receipts: Receipt[];
  idempotency: Map<string, { hash: string; value: unknown }>;
  store: Store;
  members: Member[];
  currentMemberId: string;
  categories: Category[];
  products: ProductRecord[];
  images: Map<string, Image>;
  sales: Sale[];
  expenses: Expense[];
  alerts: MarginAlert[];
  manualLines: ManualLine[];
  dayCloses: Map<string, DayClose>;
  scans: Map<string, Scan>;
  scanCount: number;
  singleScanCount: number;
};

export const STORE_ID = seedUuid(1);
export const LEAD_ID = seedUuid(10);
export const SELLER_IDS = [seedUuid(11), seedUuid(12)] as const;

export const CATEGORY_IDS = {
  drinks: seedUuid(100),
  noodles: seedUuid(101),
  dairy: seedUuid(102),
  pantry: seedUuid(103),
  household: seedUuid(104),
} as const;

type SeedProduct = {
  key: string;
  name: string;
  price: number;
  cost: number;
  category: keyof typeof CATEGORY_IDS;
  unit: string;
  images: ProductImageSlug[];
  extraUnit?: { name: string; quantity: number; price: number };
};

const SEED_PRODUCTS: SeedProduct[] = [
  {
    key: 'coca',
    name: 'Coca-Cola lon 330ml',
    price: 10000,
    cost: 7500,
    category: 'drinks',
    unit: 'lon',
    images: ['coca', 'coca-b'],
    extraUnit: { name: 'thùng', quantity: 24, price: 230000 },
  },
  {
    key: 'pepsi',
    name: 'Pepsi lon 330ml',
    price: 9000,
    cost: 9500,
    category: 'drinks',
    unit: 'lon',
    images: ['pepsi'],
  },
  {
    key: '7up',
    name: '7Up lon 330ml',
    price: 9000,
    cost: 7000,
    category: 'drinks',
    unit: 'lon',
    images: ['7up'],
  },
  {
    key: 'lavie',
    name: 'Nước suối Lavie 500ml',
    price: 5000,
    cost: 3500,
    category: 'drinks',
    unit: 'chai',
    images: ['lavie'],
  },
  {
    key: 'haohao',
    name: 'Mì Hảo Hảo tôm chua cay',
    price: 4500,
    cost: 3600,
    category: 'noodles',
    unit: 'gói',
    images: ['haohao', 'haohao-b'],
    extraUnit: { name: 'thùng', quantity: 30, price: 125000 },
  },
  {
    key: 'omachi',
    name: 'Mì Omachi sườn hầm',
    price: 7000,
    cost: 5800,
    category: 'noodles',
    unit: 'gói',
    images: ['omachi'],
  },
  {
    key: 'vinamilk',
    name: 'Sữa Vinamilk 180ml',
    price: 8000,
    cost: 6500,
    category: 'dairy',
    unit: 'hộp',
    images: ['vinamilk', 'vinamilk-b'],
  },
  {
    key: 'oreo',
    name: 'Bánh Oreo 133g',
    price: 12000,
    cost: 9500,
    category: 'dairy',
    unit: 'gói',
    images: ['oreo'],
  },
  {
    key: 'trung',
    name: 'Trứng gà (vỉ 10)',
    price: 35000,
    cost: 30000,
    category: 'pantry',
    unit: 'vỉ',
    images: ['trung'],
  },
  {
    key: 'tuongan',
    name: 'Dầu ăn Tường An 1L',
    price: 52000,
    cost: 46000,
    category: 'pantry',
    unit: 'chai',
    images: ['tuongan'],
  },
  {
    key: 'namngu',
    name: 'Nước mắm Nam Ngư 500ml',
    price: 36000,
    cost: 33500,
    category: 'pantry',
    unit: 'chai',
    images: ['namngu'],
  },
  {
    key: 'omo',
    name: 'Bột giặt OMO 800g',
    price: 48000,
    cost: 41000,
    category: 'household',
    unit: 'gói',
    images: ['omo'],
  },
  {
    key: 'aquafina',
    name: 'Nước suối Aquafina 500ml',
    price: 6000,
    cost: 5000,
    category: 'drinks',
    unit: 'chai',
    images: ['lavie'],
  },
];

/** Seed product ids by key, e.g. `PRODUCT_IDS.coca`. */
export const PRODUCT_IDS = Object.fromEntries(
  SEED_PRODUCTS.map((p, i) => [p.key, seedUuid(1000 + i)]),
) as Record<
  | 'coca'
  | 'pepsi'
  | '7up'
  | 'lavie'
  | 'haohao'
  | 'omachi'
  | 'vinamilk'
  | 'oreo'
  | 'trung'
  | 'tuongan'
  | 'namngu'
  | 'omo'
  | 'aquafina',
  string
>;

export const MARGIN_THRESHOLD_PCT = 10;

export function marginPct(price: number, cost: number): number {
  if (price <= 0) return 0;
  return Math.round(((price - cost) / price) * 1000) / 10;
}

/** Cheapest round price (to 500đ) that clears a 15 % margin over cost. */
export function suggestPrice(cost: number): number {
  return Math.ceil(cost / 0.85 / 500) * 500;
}

export function makeAlert(
  product: Product,
  id: string,
  at: string,
  status: MarginAlert['status'] = 'open',
  expenseId: string | null = null,
): MarginAlert {
  const cost = product.cost_price ?? 0;
  return {
    id,
    product_id: product.id,
    product_name: product.name ?? null,
    cost_price: cost,
    selling_price: product.price,
    margin_pct: marginPct(product.price, cost),
    suggested_price: suggestPrice(cost),
    status,
    expense_id: expenseId,
    created_at: at,
  };
}

/** Small deterministic PRNG so seed sales are the same on every run. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function buildSeed(now: Date = new Date()): MockState {
  const iso = now.toISOString();
  const expires = new Date(
    now.getTime() + 365 * 24 * 3600 * 1000,
  ).toISOString();
  const today = businessDate(now);
  // Seed times are fixed clock hours of their business date; today's must not lie ahead of `now`.
  const latest = new Date(now.getTime() - 60_000).toISOString();
  const seededAt = (at: string) => {
    const iso = new Date(at).toISOString();
    return iso > latest ? latest : iso;
  };

  const store: Store = {
    id: STORE_ID,
    name: 'Tạp hóa Cô Ba',
    bank_account: {
      bank_bin: '970436',
      bank_short_name: 'VCB',
      account_number: '0123456789',
      account_name: 'NGUYEN THI BA',
    },
    timezone: 'Asia/Ho_Chi_Minh',
    margin_threshold_pct: MARGIN_THRESHOLD_PCT,
    low_stock_threshold: 5,
    sales_memo_prefix: 'TH',
    created_at: iso,
    version: 1,
  };

  const members: Member[] = [
    ['Cô Ba', 'lead', true, LEAD_ID],
    ['Bà nội', 'seller', false, SELLER_IDS[0]],
    ['Chú Tư', 'seller', true, SELLER_IDS[1]],
  ].map(([display_name, role, can_enroll, id]) => ({
    id: id as string,
    display_name: display_name as string,
    role: role as Member['role'],
    can_enroll: can_enroll as boolean,
    has_pin: role === 'lead',
    active: true,
    created_at: iso,
  }));

  const categories: Category[] = [
    { id: CATEGORY_IDS.drinks, name: 'Nước giải khát' },
    { id: CATEGORY_IDS.noodles, name: 'Mì & đồ khô' },
    { id: CATEGORY_IDS.dairy, name: 'Sữa & bánh kẹo' },
    { id: CATEGORY_IDS.pantry, name: 'Gia vị & dầu ăn' },
    { id: CATEGORY_IDS.household, name: 'Hóa phẩm' },
  ];

  const images = new Map<string, Image>();
  let imageSeq = 2000;
  const products: ProductRecord[] = SEED_PRODUCTS.map((seed, index) => {
    const productImages: ProductImage[] = seed.images.map((slug, position) => {
      const image: Image = {
        id: seedUuid(imageSeq),
        object_key: `images/seed/${slug}.png`,
        content_type: 'image/png',
        byte_size: 480,
        purpose: 'enrollment',
        width: 160,
        height: 160,
        url: productImageUri(slug),
        url_expires_at: expires,
      };
      imageSeq += 1;
      images.set(image.id, image);
      return {
        image_id: image.id,
        url: image.url,
        url_expires_at: expires,
        position,
      };
    });
    const product: Product = {
      id: seedUuid(1000 + index),
      name: seed.name,
      price: seed.price,
      base_unit: seed.unit,
      cost_price: seed.cost,
      barcode: null,
      category_id: CATEGORY_IDS[seed.category],
      units: seed.extraUnit
        ? [
            {
              id: seedUuid(3000 + index),
              name: seed.extraUnit.name,
              quantity_in_base: seed.extraUnit.quantity,
              price: seed.extraUnit.price,
              barcode: null,
            },
          ]
        : [],
      images: productImages,
      index_status: 'ready',
      stock_quantity:
        seed.key === 'coca'
          ? 20
          : seed.key === 'haohao'
            ? 3
            : seed.key === 'pepsi'
              ? 0
              : null,
      low_stock_threshold: null,
      stock_status:
        seed.key === 'coca'
          ? 'ok'
          : seed.key === 'haohao'
            ? 'low'
            : seed.key === 'pepsi'
              ? 'out'
              : 'untracked',
      archived: false,
      version: 1,
      created_by: LEAD_ID,
      updated_at: iso,
    };
    return { product };
  });

  const byKey = (key: keyof typeof PRODUCT_IDS) =>
    products.find((p) => p.product.id === PRODUCT_IDS[key])!.product;
  const alerts = [
    makeAlert(byKey('pepsi'), seedUuid(5000), iso),
    makeAlert(byKey('namngu'), seedUuid(5001), iso),
  ];

  const rand = lcg(20261023);
  const sales: Sale[] = [];
  const manualLines: ManualLine[] = [];
  /** Sales (by sequence) that include a hand-priced line, i.e. "sold without catalog". */
  const MANUAL_SEEDS: Record<number, [string, number, number]> = {
    3: ['Kẹo lạc', 5000, 2],
    11: ['Bánh tráng', 8000, 1],
    20: ['Rau thơm', 12000, 1],
  };
  const expenses: Expense[] = [];
  let saleSeq = 0;
  let expenseSeq = 0;
  const expenseKinds: [ExpenseCategory, number, 'cash_box' | 'other'][] = [
    ['khac', 30000, 'cash_box'],
    ['nhap_hang', 60000, 'cash_box'],
    ['dien', 420000, 'other'],
    ['nhap_hang', 50000, 'cash_box'],
    ['nuoc', 85000, 'other'],
    ['khac', 20000, 'cash_box'],
    ['nhap_hang', 40000, 'cash_box'],
  ];

  for (let back = 0; back < 7; back += 1) {
    const date = addDays(today, -back);
    const count = back === 0 ? 5 : 6 + Math.floor(rand() * 3);
    for (let n = 0; n < count; n += 1) {
      saleSeq += 1;
      const lineCount = 1 + Math.floor(rand() * 3);
      const lines: SaleLine[] = Array.from({ length: lineCount }, (_, l) => {
        const product = products[Math.floor(rand() * products.length)]!.product;
        const quantity = 1 + Math.floor(rand() * 3);
        return {
          id: seedUuid(10000 + saleSeq * 10 + l),
          product_id: product.id,
          unit_id: null,
          source: 'camera' as const,
          quantity,
          unit_price: product.price,
          line_total: product.price * quantity,
          price_mismatch: false,
          product_name: product.name ?? null,
        };
      });
      const manualSeed = MANUAL_SEEDS[saleSeq];
      const manualLineId = seedUuid(30000 + saleSeq);
      if (manualSeed) {
        const [label, price, quantity] = manualSeed;
        lines.push({
          id: manualLineId,
          product_id: null,
          unit_id: null,
          source: 'manual',
          quantity,
          unit_price: price,
          line_total: price * quantity,
          price_mismatch: false,
          product_name: null,
          manual_label: label,
        });
      }
      const total = lines.reduce((sum, l) => sum + l.line_total, 0);
      const method: PaymentMethod = rand() < 0.6 ? 'cash' : 'transfer';
      const hour = String(7 + Math.floor((n * 12) / count)).padStart(2, '0');
      const soldAt = `${date}T${hour}:${String(10 + n * 7).padStart(2, '0')}:00+07:00`;
      const cashReceived =
        method === 'cash' ? Math.ceil(total / 10000) * 10000 : null;
      const saleId = seedUuid(10000 + saleSeq * 10 + 9);
      const soldAtIso = seededAt(soldAt);
      const memberId = n % 3 === 0 ? LEAD_ID : SELLER_IDS[n % 2]!;
      if (manualSeed) {
        const [label, price, quantity] = manualSeed;
        manualLines.push({
          line_id: manualLineId,
          sale_id: saleId,
          sold_at: soldAtIso,
          sold_by: memberId,
          unit_price: price,
          quantity,
          manual_label: label,
          crop_image: null,
          reason: 'manual_price',
          status: 'open',
          resolution: null,
        });
      }
      sales.push({
        id: saleId,
        code: randomCode(6),
        sold_at: soldAtIso,
        received_at: soldAtIso,
        business_date: date,
        member_id: memberId,
        payment_method: method,
        credit_amount: 0,
        cash_received: cashReceived,
        change_given: cashReceived === null ? null : cashReceived - total,
        total,
        vietqr_memo: method === 'transfer' ? `TH ${randomCode(6)}` : null,
        status: 'completed',
        void: null,
        lines,
      });
    }
    const [category, amount, paidWith] = expenseKinds[back]!;
    expenseSeq += 1;
    const spentAt = seededAt(`${date}T16:00:00+07:00`);
    expenses.push({
      id: seedUuid(20000 + expenseSeq),
      spent_at: spentAt,
      amount,
      category,
      paid_with: paidWith,
      note:
        category === 'nhap_hang' ? 'Nhập hàng đại lý' : 'Chi phí trong ngày',
      business_date: date,
      member_id: LEAD_ID,
      image: null,
      alerts: [],
      created_at: spentAt,
    });
  }

  const yesterday = addDays(today, -1);
  const yesterdayCash = sales
    .filter((s) => s.business_date === yesterday && s.payment_method === 'cash')
    .reduce((sum, s) => sum + s.total, 0);
  const yesterdayCashOut = expenses
    .filter((e) => e.business_date === yesterday && e.paid_with === 'cash_box')
    .reduce((sum, e) => sum + e.amount, 0);
  const yesterdayExpected = Math.max(0, yesterdayCash - yesterdayCashOut);
  const dayCloses = new Map<string, DayClose>([
    [
      yesterday,
      {
        business_date: yesterday,
        opening_float: 0,
        cash_sales: yesterdayCash,
        cash_refunds: 0,
        cash_expenses: yesterdayCashOut,
        expected_cash: yesterdayExpected,
        counted_cash: yesterdayExpected,
        difference: 0,
        transfer_revenue: sales
          .filter(
            (s) =>
              s.business_date === yesterday && s.payment_method === 'transfer',
          )
          .reduce((sum, s) => sum + s.total, 0),
        late_sales_count: 0,
        note: null,
        closed_by: LEAD_ID,
        closed_at: new Date(`${yesterday}T21:00:00+07:00`).toISOString(),
      },
    ],
  ]);

  return {
    documentImageIds: new Set(),
    stockMovements: new Map(),
    receipts: [],
    idempotency: new Map(),
    customers: [],
    debtEntries: [],
    store,
    members,
    currentMemberId: LEAD_ID,
    categories,
    products,
    images,
    sales,
    expenses,
    alerts,
    manualLines,
    dayCloses,
    scans: new Map(),
    scanCount: 0,
    singleScanCount: 0,
  };
}

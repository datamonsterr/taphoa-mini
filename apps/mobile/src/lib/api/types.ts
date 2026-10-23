import type { components } from '@taphoa/api-client';

type Schemas = components['schemas'];

export type ApiErrorBody = Schemas['Error'];
export type Store = Schemas['Store'];
export type StorePatch = Schemas['StorePatch'];
export type BankAccount = Schemas['BankAccount'];
export type Member = Schemas['Member'];
export type Role = Schemas['Role'];
export type Invite = Schemas['Invite'];
export type Image = Schemas['Image'];
export type ImagePurpose = Schemas['ImagePurpose'];
export type Scan = Schemas['Scan'];
export type Detection = Schemas['Detection'];
export type Candidate = Schemas['Candidate'];
export type Category = Schemas['Category'];
export type Product = Schemas['Product'];
export type ProductUnit = Schemas['ProductUnit'];
export type ProductImage = Schemas['ProductImage'];
export type CreateProductRequest = Schemas['CreateProductRequest'];
export type ProductPatch = Schemas['ProductPatch'];
export type PaymentMethod = Schemas['PaymentMethod'];
export type Sale = Schemas['Sale'];
export type SaleLine = Schemas['SaleLine'];
export type SaleLineInput = Schemas['SaleLineInput'];
export type CreateSaleRequest = Schemas['CreateSaleRequest'];
export type Expense = Schemas['Expense'];
export type ExpenseCategory = Schemas['ExpenseCategory'];
export type CreateExpenseRequest = Schemas['CreateExpenseRequest'];
export type MarginAlert = Schemas['MarginAlert'];
export type DailyReport = Schemas['DailyReport'];
export type SummaryBucket = Schemas['SummaryBucket'];
export type DayClose = Schemas['DayClose'];
export type ManualLine = Schemas['ManualLine'];
export type ManualLineStatus = ManualLine['status'];
export type ResolveManualLineInput = {
  action: 'link' | 'enrolled' | 'dismiss';
  /** Required for `link` and `enrolled`. */
  product_id?: string;
};

/**
 * Proposed API extension: Product.stock_quantity (pending spec).
 * The mock returns it on every Product response; the real API does not yet.
 */
export type ProductWithStock = Product & { stock_quantity?: number };

export type Page<T> = { items: T[]; next_cursor: string | null };
export type SummaryGranularity = 'day' | 'week' | 'month';
export type SummaryReport = {
  granularity: SummaryGranularity;
  buckets: SummaryBucket[];
};
export type ReportPeriod = SummaryGranularity;
export type AlertStatus = MarginAlert['status'];
export type ScanMode = Scan['mode'];
export type ScanPurpose = Scan['purpose'];

/** A React Native file part (`{ uri, name, type }`) or a web Blob/File. */
export type UploadFile = { uri: string; name: string; type: string } | Blob;

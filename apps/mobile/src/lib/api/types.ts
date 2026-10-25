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
export type ProductIndexStatus = Product['index_status'];
export type ProductUnit = Schemas['ProductUnit'];
export type ProductImage = Schemas['ProductImage'];
export type ProductReference = Schemas['ProductReference'];
export type CreateProductRequest = Schemas['CreateProductRequest'];
export type ProductPatch = Schemas['ProductPatch'];
export type SegmentPointsRequest = Schemas['SegmentPointsRequest'];
export type SegmentPointsResponse = Schemas['SegmentPointsResponse'];
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

export type StockItem = Schemas['StockItem'];
export type StockMovement = Schemas['StockMovement'];
export type StockAdjustment = Schemas['StockAdjustment'];
export type Receipt = Schemas['Receipt'];
export type ReceiptLine = Schemas['ReceiptLine'];
export type ReceiptSummary = Schemas['ReceiptSummary'];
export type ReceiptCreate = Schemas['ReceiptCreate'];
export type ReceiptConfirm = Schemas['ReceiptConfirm'];
export type ScanDocument = Schemas['ScanDocument'];

export type Customer = Schemas['Customer'];

export type CreateCustomerRequest = Schemas['CreateCustomerRequest'];

export type UpdateCustomerRequest = Schemas['UpdateCustomerRequest'];

export type DebtEntry = Schemas['DebtEntry'];

export type CreateRepaymentRequest = Schemas['CreateRepaymentRequest'];

export type CreateDebtAdjustmentRequest =
  Schemas['CreateDebtAdjustmentRequest'];

export type DebtSummary = Schemas['DebtSummary'];

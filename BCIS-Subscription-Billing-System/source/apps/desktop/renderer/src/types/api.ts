/**
 * Response shapes for the endpoints the client consumes.
 *
 * These were captured from the running API rather than assumed. They differ
 * from the DTOs in `@bcis/shared/types`, which describe the *detail* resources
 * and an earlier dashboard design: the implemented dashboard groups its figures
 * into `subscribers` / `accounts` / `receivables` / `collections` / `gcash` /
 * `billing` / `collectionBatches` sections, and every money figure is returned
 * twice, once as integer centavos and once as a pre-formatted display string
 * named after the figure (`outstanding`, `amount`, `current`, ...).
 *
 * The display string is the authoritative one for rendering. Re-deriving a peso
 * string on the client is exactly how a screen ends up disagreeing with the
 * ledger, so `useMoney` below prefers the server's value.
 */

export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

/* ------------------------------------------------------------------ money */

export interface MoneyFields {
  /** Integer centavos. Never do arithmetic on the display string. */
  [key: string]: number | string | undefined
}

/* ------------------------------------------------------------- dashboard */

export interface DashboardSubscribers {
  total: number
  active: number
  inactive: number
  newInPeriod: number
}

export interface DashboardAccounts {
  total: number
  pendingActivation: number
  active: number
  suspended: number
  disconnected: number
  terminated: number
}

export interface DashboardReceivables {
  currentCentavos: number
  current: string
  overdueCentavos: number
  overdue: string
  totalOutstandingCentavos: number
  totalOutstanding: string
  overdueAccounts: number
  collectionRate: number
}

export interface DashboardMethodTotal {
  method: string
  count: number
  amountCentavos: number
  amount: string
}

export interface DashboardCollections {
  receivedCentavos: number
  received: string
  paymentsInPeriod: number
  averagePayment: string
  byMethod: DashboardMethodTotal[]
}

export interface DashboardGcash {
  pending: number
  verifiedInPeriod: number
  rejectedInPeriod: number
}

export interface DashboardBilling {
  issuedInPeriod: number
  paidInPeriod: number
  voidedInPeriod: number
  outstandingInvoices: number
}

export interface DashboardBatches {
  open: number
  inProgress: number
  submitted: number
  remitted: number
  reconciled: number
  uncollectedCentavos: number
  uncollected: string
}

export interface DashboardOverdueAccount {
  accountNumber: string
  subscriberName: string
  amountCentavos: number
  amount: string
  daysOverdue: number
}

export interface DashboardResponse {
  generatedAt: string
  period: { from: string; to: string; days: number }
  subscribers: DashboardSubscribers
  accounts: DashboardAccounts
  receivables: DashboardReceivables
  collections: DashboardCollections
  gcash: DashboardGcash
  billing: DashboardBilling
  collectionBatches: DashboardBatches
  topOverdue: DashboardOverdueAccount[]
}

/* ------------------------------------------------------------ subscribers */

export interface SubscriberListRow {
  id: string
  accountNumber: string
  fullName: string
  contactNumber: string
  addressLine: string
  city: string
  status: string
  areaId: string
  areaName: string
  serviceAccountCount: number
  outstandingCentavos: number
  /** Pre-formatted by the server, for example `₱1,234.56` or `-`. */
  outstanding: string
}

/* -------------------------------------------------------- service accounts */

export interface ServiceAccountListRow {
  id: string
  serviceAccountNumber: string
  status: string
  installationAddress: string
  activationDate: string
  billingStartPeriod: string
  billingDueDay: number
  currentRateCentavos: number
  creditBalanceCentavos: number
  subscriberId: string
  subscriberName: string
  accountNumber: string
  planId: string
  planName: string
  serviceType: string
  areaId: string
  areaName: string
  collectorId: string | null
  collectorName: string | null
  outstandingCentavos: number
  outstanding: string
}

/* ------------------------------------------------------------- directory */

export interface CollectionAreaRow {
  id: string
  code: string
  name: string
  description: string
  isActive: boolean
  createdAt: string
}

export interface CollectionRouteRow {
  id: string
  areaId: string
  areaName: string
  code: string
  name: string
  description: string
  isActive: boolean
}

export interface CollectorRow {
  id: string
  code: string
  fullName: string
  contactNumber: string
  isActive: boolean
  createdAt: string
}

export interface TechnicianRow {
  id: string
  code: string
  fullName: string
  contactNumber: string
  isActive: boolean
}

export interface PlanRow {
  id: string
  code: string
  name: string
  serviceType: string
  serviceTypeName: string
  monthlyPriceCentavos: number
  installationFeeCentavos: number
  reconnectionFeeCentavos: number
  speedMbps: number | null
  channelCount: number | null
  description: string
  isActive: boolean
  updatedAt: string
}

export interface SubscriberDetail {
  id: string
  accountNumber: string
  fullName: string
  contactNumber: string
  email: string | null
  addressLine: string
  city: string
  status: string
  notes: string | null
  billingDueDay: number
  createdAt: string
  /** A subscriber is not required to belong to a collection area. */
  areaId: string | null
  areaName: string | null
  areaCode: string | null
  addresses: SubscriberAddress[]
}

export interface SubscriberAddress {
  id: string
  subscriberId: string
  label: string
  addressLine: string
  city: string
  isPrincipal: boolean
  createdAt: string
}

export interface ServiceAccountDetail {
  id: string
  serviceAccountNumber: string
  status: string
  installationAddress: string
  activationDate: string
  billingStartPeriod: string
  billingDueDay: number
  currentRateCentavos: number
  creditBalanceCentavos: number
  notes: string | null
  subscriberId: string
  subscriberName: string
  accountNumber: string
  contactNumber: string
  subscriberStatus: string
  planId: string
  planName: string
  planCode: string
  serviceType: string
  reconnectionFeeCentavos: number
  installationFeeCentavos: number
  areaId: string
  areaName: string
  collectorId: string | null
  collectorName: string | null
}

export interface ServiceEvent {
  id: string
  serviceAccountId: string
  eventType: string
  reason: string
  effectiveDate: string
  notes: string | null
  actorId: string
  actorName: string
  /** A JSON string, not an object, so it is parsed defensively on render. */
  metadata: string | null
  createdAt: string
}

/* ------------------------------------------------------------ collections */

export interface CollectionBatchRow {
  id: string
  batchNumber: string
  batchDate: string
  status: string
  areaId: string
  routeId: string
  collectorId: string
  accountCount: number
  expectedReceivableCentavos: number
  cashCollectedCentavos: number
  nonCashCollectedCentavos: number
  totalCollectedCentavos: number
  uncollectedCentavos: number
  openedByName: string
  submittedAt: string | null
  remittedAt: string | null
  reconciledAt: string | null
  closedAt: string | null
  areaName: string
  routeName: string
  collectorName: string
}

export interface RemittanceRow {
  id: string
  remittanceNumber: string
  batchId: string
  collectorId: string
  remittanceDate: string
  cashCollectedCentavos: number
  cashRemittedCentavos: number
  nonCashCollectedCentavos: number
  differenceCentavos: number
  shortageCentavos: number
  overageCentavos: number
  status: string
  rejectionReason: string | null
  remarks: string | null
  submittedByName: string
  confirmedByName: string | null
  submittedAt: string
  confirmedAt: string | null
  batchNumber: string
  batchDate: string
  collectorName: string
}

export interface SuspensionRow {
  id: string
  reason: string
  /** A date, not a timestamp: the day the cut-off takes effect. */
  effectiveDate: string
  arrearsAtSuspensionCentavos: number
  status: string
  approvedByName: string | null
  approvedAt: string | null
  executedAt: string | null
  cancelledAt: string | null
  notes: string | null
  createdByName: string
  createdAt: string
  serviceAccountId: string
  serviceAccountNumber: string
  accountStatus: string
  subscriberId: string
  subscriberName: string
  subscriberAccountNumber: string
  planCode: string
  planName: string
  money: Record<string, string>
}

export interface ReconnectionRow {
  id: string
  feeCentavos: number
  requestDate: string
  requestedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  status: string
  technicianId: string | null
  notes: string
  createdByName: string
  createdAt: string
  suspensionEffectiveDate: string | null
  suspensionReason: string | null
  feeInvoiceNumber: string | null
  feeStatus: string | null
  feeBalanceCentavos: number
  serviceAccountId: string
  serviceAccountNumber: string
  accountStatus: string
  subscriberId: string
  subscriberName: string
  subscriberAccountNumber: string
  planCode: string
  planName: string
  money: Record<string, string>
}

export interface ItemsResponse<T> {
  items: T[]
}

/* --------------------------------------------------- receivables & reports */

export interface AgingBucket {
  bucket: 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS'
  label: string
  amountCentavos: number
  invoiceCount: number
  accountCount: number
}

export interface OverdueAccountRow {
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberId: string
  subscriberName: string
  subscriberAccountNumber: string
  contactNumber: string
  installationAddress: string
  accountStatus: string
  planCode: string
  planName: string
  serviceTypeName: string
  collectorCode: string | null
  collectorName: string | null
  areaCode: string
  areaName: string
  monthsUnpaid: number
  currentBillCentavos: number
  arrearsCentavos: number
  totalArrearsCentavos: number
  oldestUnpaidInvoice: {
    invoiceNumber: string
    period: string
    dueDate: string
    daysPastDue: number
  } | null
  lastPayment: { receiptNumber: string; paidAt: string; amountCentavos: number } | null
  isSuspensionCandidate: boolean
}

export interface OverdueResponse {
  asOf: string
  page: number
  pageSize: number
  total: number
  items: OverdueAccountRow[]
}

export interface CollectorPerformanceRow {
  collectorId: string
  collectorName: string
  batchCount: number
  expectedReceivableCentavos: number
  totalCollectedCentavos: number
  uncollectedCentavos: number
  /** Whole percent; the API rounds so the client never re-derives a rate. */
  collectionRate: number
  shortageCentavos: number
  overageCentavos: number
  money: Record<string, string>
}

/** `GET /collection/performance` returns the rows under `items`, not a page. */
export interface ItemsResponse<T> {
  items: T[]
}

export interface CollectionsReportResponse {
  from: string
  to: string
  granularity: string
  buckets: Array<{
    period: string
    postedCount: number
    collectedCentavos: number
    methods: Record<string, number>
  }>
  totals: {
    postedCount: number
    collectedCentavos: number
    methods: Record<string, number>
  }
}

/* ---------------------------------------------------------------- billing */

export interface BillingCycleRow {
  id: string
  period: string
  status: string
  generatedAt: string
  generatedBy: string
  generatedByName: string
  invoiceCount: number
  totalBilledCentavos: number
  finalizedAt: string | null
  createdAt: string
}

export interface BillingSummaryRow {
  status: string
  totalCentavos: number
  balanceCentavos: number
  invoiceCount: number
}

export interface BillingCycleSummaryResponse {
  period: string
  rows: BillingSummaryRow[]
}

/* --------------------------------------------------------------- invoices */

export interface InvoiceListRow {
  id: string
  invoiceNumber: string
  period: string
  issueDate: string
  dueDate: string
  totalCentavos: number
  paidCentavos: number
  balanceCentavos: number
  status: string
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberId: string
  subscriberName: string
  accountNumber: string
  areaName: string
  collectorName: string | null
  planName: string
  serviceType: string
  /** Server-formatted strings: total, paid, balance. */
  total: string
  paid: string
  balance: string
}

export interface InvoiceListResponse {
  items: InvoiceListRow[]
  page: number
  pageSize: number
  total: number
  totalBalanceCentavos: number
}

export interface InvoiceItem {
  id: string
  itemType: string
  description: string
  quantity: string
  unitPriceCentavos: number
  amountCentavos: number
  sortOrder: number
  amount: string
}

export interface InvoicePayment {
  id: string
  receiptNumber: string
  paymentDate: string
  amountCentavos: number
  method: string
  amount: string
}

export interface InvoiceDetail {
  id: string
  invoiceNumber: string
  period: string
  issueDate: string
  dueDate: string
  subtotalCentavos: number
  discountCentavos: number
  penaltyCentavos: number
  totalCentavos: number
  paidCentavos: number
  balanceCentavos: number
  status: string
  isFinalized: boolean
  voidReason: string | null
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberName: string
  accountNumber: string
  installationAddress: string
  items: InvoiceItem[]
  payments: InvoicePayment[]
  /** The one place a money map is used; prefer these over re-formatting. */
  totals: {
    subtotal: string
    discount: string
    penalty: string
    total: string
    paid: string
    balance: string
  }
}

/* ----------------------------------------------------------------- ledger */

export interface LedgerEntry {
  id: string
  entryDate: string
  postingDate: string
  reference: string
  description: string
  entryType: string
  debitCentavos: number
  creditCentavos: number
  balanceCentavos: number
  sourceType: string
  sourceId: string
}

export interface LedgerResponse {
  items: LedgerEntry[]
  page: number
  pageSize: number
  total: number
  balanceCentavos: number
  openingBalanceCentavos: number
  closingBalanceCentavos: number
}

/* --------------------------------------------------------------- payments */

export interface PaymentListRow {
  id: string
  receiptNumber: string
  paymentDate: string
  amountCentavos: number
  allocatedCentavos: number
  advanceCentavos: number
  method: string
  referenceNumber: string | null
  status: string
  notes: string | null
  postedByName: string
  reversalReason: string | null
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberName: string
  accountNumber: string
  amount: string
  allocated: string
  advance: string
}

export interface PaymentListResponse {
  items: PaymentListRow[]
  page: number
  pageSize: number
  total: number
  totalPostedCentavos: number
}

export interface PaymentInvoiceAllocation {
  id: string
  invoiceId: string
  invoiceNumber: string
  period: string
  invoiceStatus: string
  invoiceTotalCentavos: number
  invoicePaidCentavos: number
  invoiceBalanceCentavos: number
  amountCentavos: number
  allocationType: string
  amount: string
  invoiceTotal: string
  invoicePaid: string
  invoiceBalance: string
}

export interface PaymentDetail {
  id: string
  receiptNumber: string
  paymentDate: string
  amountCentavos: number
  allocatedCentavos: number
  advanceCentavos: number
  creditAppliedCentavos: number
  method: string
  referenceNumber: string | null
  notes: string | null
  status: string
  postedByName: string
  reversalReason: string | null
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberName: string
  accountNumber: string
  totals: {
    amount: string
    allocated: string
    advance: string
    creditApplied: string
  }
  allocations: PaymentInvoiceAllocation[]
  receipt: unknown | null
  reversal: unknown | null
}

export interface AllocationLine {
  invoiceId: string
  invoiceNumber: string
  period: string
  dueDate: string
  outstandingCentavos: number
  amountCentavos: number
}

export interface AllocationPreview {
  serviceAccountId: string
  amountCentavos: number
  allocations: AllocationLine[]
  advanceCentavos: number
  existingAdvanceCentavos: number
  outstandingAfterCentavos: number
  total: { amount: string; advance: string; existingAdvance: string }
}

export interface GcashProofRow {
  id: string
  referenceNumber: string
  senderName: string
  amountCentavos: number
  status: string
  submittedByName: string
  submittedAt: string
  verifiedByName: string | null
  verifiedAt: string | null
  rejectionReason: string | null
  isDuplicateSuspect: boolean
  serviceAccountId: string
  serviceAccountNumber: string
  subscriberName: string
  amount: string
}

export interface GcashProofListResponse {
  items: GcashProofRow[]
  page: number
  pageSize: number
  total: number
}

/* --------------------------------------------------------- service control */

/**
 * The candidate list is a single unpaginated set with the policy thresholds
 * alongside it, so the user can see why an account qualifies.
 */
export interface SuspensionCandidatesResponse {
  gracePeriodDays: number
  suspensionThresholdMonths: number
  items: OverdueAccountRow[]
}

/**
 * What the client sends for a money field.
 *
 * Every write endpoint takes `amount` as a **peso decimal string**, not
 * centavos: `amountInput` runs the value through `parseCentavos`, so `"1500"`
 * means ₱1,500.00. Sending centavos here is the most likely way to post a
 * payment a hundred times too large, so the amount inputs use
 * `pesosToCentavos`/`centavosToPesosInput` to stay in peso land and pass the
 * string straight through.
 */
export type AmountInput = string

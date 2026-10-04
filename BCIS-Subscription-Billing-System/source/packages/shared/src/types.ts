import type {
  AgingBucketCode,
  AllocationType,
  BackupStatus,
  BatchAccountStatus,
  BatchStatus,
  BillingCycleStatus,
  InvoiceItemType,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  ProofStatus,
  ReconnectionStatus,
  RemittanceStatus,
  ServiceAccountStatus,
  ServiceEventType,
  ServiceTypeCode,
  SubscriberStatus,
  SuspensionStatus
} from "./enums.js";
import type { Permission, RoleCode } from "./permissions.js";

/** Envelope returned by every paginated endpoint. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  roles: RoleCode[];
  permissions: Permission[];
  lastLoginAt: string | null;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export interface RoleSummary {
  id: string;
  code: RoleCode;
  name: string;
  description: string;
  permissions: Permission[];
  userCount: number;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  lastLoginAt: string | null;
  createdAt: string;
  roles: Array<{ id: string; code: RoleCode; name: string }>;
}

export interface PlanSummary {
  id: string;
  code: string;
  name: string;
  serviceType: ServiceTypeCode;
  serviceTypeName: string;
  monthlyPriceCentavos: number;
  installationFeeCentavos: number;
  reconnectionFeeCentavos: number;
  speedMbps: number | null;
  channelCount: number | null;
  description: string;
  isActive: boolean;
  subscriberCount: number;
  createdAt: string;
}

export interface AddressSummary {
  id: string;
  label: string;
  addressLine: string;
  city: string;
  isPrincipal: boolean;
}

export interface CollectorSummary {
  id: string;
  code: string;
  fullName: string;
  contactNumber: string;
  isActive: boolean;
}

export interface CollectionAreaSummary {
  id: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  routeCount: number;
  subscriberCount: number;
}

export interface CollectionRouteSummary {
  id: string;
  areaId: string;
  areaName: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  assignedAccountCount: number;
}

export interface TechnicianSummary {
  id: string;
  code: string;
  fullName: string;
  contactNumber: string;
  isActive: boolean;
}

export interface ServiceAccountSummary {
  id: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberAccountNumber: string;
  subscriberName: string;
  contactNumber: string;
  planId: string;
  planName: string;
  planCode: string;
  serviceType: ServiceTypeCode;
  installationAddress: string;
  activationDate: string;
  billingStartPeriod: string;
  billingDueDay: number;
  currentRateCentavos: number;
  status: ServiceAccountStatus;
  collectorId: string | null;
  collectorName: string | null;
  collectionAreaId: string | null;
  collectionAreaName: string | null;
  routeId: string | null;
  creditBalanceCentavos: number;
  outstandingCentavos: number;
  arrearsCentavos: number;
  currentBillCentavos: number;
  oldestUnpaidDueDate: string | null;
  monthsUnpaid: number;
  lastPaymentAt: string | null;
}

export interface SubscriberSummary {
  id: string;
  accountNumber: string;
  fullName: string;
  contactNumber: string;
  email: string | null;
  addressLine: string;
  city: string;
  collectionAreaId: string;
  collectionAreaName: string;
  status: SubscriberStatus;
  notes: string | null;
  createdAt: string;
  addresses: AddressSummary[];
  accounts: ServiceAccountSummary[];
  outstandingCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  lastPaymentAt: string | null;
}

export interface ServiceEventSummary {
  id: string;
  serviceAccountNumber: string;
  eventType: ServiceEventType;
  reason: string | null;
  effectiveDate: string;
  notes: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface InvoiceItemSummary {
  id: string;
  itemType: InvoiceItemType;
  description: string;
  quantity: number;
  unitPriceCentavos: number;
  amountCentavos: number;
  sortOrder: number;
}

export interface BillingCycleSummary {
  id: string;
  period: string;
  status: BillingCycleStatus;
  generatedAt: string | null;
  generatedByName: string | null;
  invoiceCount: number;
  totalBilledCentavos: number;
  finalizedAt: string | null;
  createdAt: string;
}

export interface InvoiceStatusBreakdown {
  status: InvoiceStatus;
  invoiceCount: number;
  totalCentavos: number;
  balanceCentavos: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  subscriberAccountNumber: string;
  collectionAreaName: string | null;
  collectorName: string | null;
  planName: string | null;
  serviceType: ServiceTypeCode | null;
  period: string;
  issueDate: string;
  dueDate: string;
  subtotalCentavos: number;
  discountCentavos: number;
  penaltyCentavos: number;
  totalCentavos: number;
  paidCentavos: number;
  balanceCentavos: number;
  status: InvoiceStatus;
  ageDays: number;
  items: InvoiceItemSummary[];
  createdAt: string;
}

export interface LedgerEntrySummary {
  id: string;
  entryDate: string;
  reference: string;
  description: string;
  debitCentavos: number;
  creditCentavos: number;
  balanceCentavos: number;
  entryType: string;
  createdAt: string;
}

export interface AllocationSummary {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  period: string;
  amountCentavos: number;
  allocationType: AllocationType;
}

export interface PaymentSummary {
  id: string;
  receiptNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  subscriberAccountNumber: string;
  paymentDate: string;
  amountCentavos: number;
  method: PaymentMethod;
  referenceNumber: string | null;
  notes: string | null;
  status: PaymentStatus;
  advanceCentavos: number;
  creditAppliedCentavos: number;
  postedByName: string | null;
  collectorName: string | null;
  batchNumber: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  allocations: AllocationSummary[];
  receiptVoidedAt: string | null;
  receiptVoidReason: string | null;
  createdAt: string;
}

export interface AllocationPreviewLine {
  invoiceId: string;
  invoiceNumber: string;
  period: string;
  dueDate: string;
  invoiceBalanceCentavos: number;
  allocatedCentavos: number;
  remainingCentavos: number;
}

export interface AllocationPreview {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  accountCreditCentavos: number;
  paymentAmountCentavos: number;
  creditAppliedCentavos: number;
  cashToAllocateCentavos: number;
  lines: AllocationPreviewLine[];
  advanceCentavos: number;
  resultingBalanceCentavos: number;
}

export interface GcashProofSummary {
  id: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  amountCentavos: number;
  referenceNumber: string;
  senderName: string;
  proofNote: string | null;
  attachmentId: string | null;
  attachmentName: string | null;
  status: ProofStatus;
  submittedByName: string | null;
  submittedAt: string;
  verifiedByName: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  paymentId: string | null;
  receiptNumber: string | null;
}

export interface BatchAccountSummary {
  id: string;
  batchId: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  subscriberAccountNumber: string;
  address: string;
  planName: string;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  collectedCentavos: number;
  outstandingAfterCentavos: number;
  status: BatchAccountStatus;
  collectionNotes: string | null;
  collectedAt: string | null;
}

export interface RemittanceSummary {
  id: string;
  remittanceNumber: string;
  batchId: string;
  batchNumber: string;
  collectorId: string;
  collectorName: string;
  remittanceDate: string;
  cashCollectedCentavos: number;
  cashRemittedCentavos: number;
  nonCashCollectedCentavos: number;
  differenceCentavos: number;
  shortageCentavos: number;
  overageCentavos: number;
  status: RemittanceStatus;
  confirmedByName: string | null;
  confirmedAt: string | null;
  remarks: string | null;
  createdAt: string;
}

export interface CollectionBatchSummary {
  id: string;
  batchNumber: string;
  areaId: string;
  areaName: string;
  routeId: string | null;
  routeName: string | null;
  collectorId: string;
  collectorName: string;
  batchDate: string;
  status: BatchStatus;
  accountCount: number;
  expectedReceivableCentavos: number;
  cashCollectedCentavos: number;
  nonCashCollectedCentavos: number;
  totalCollectedCentavos: number;
  uncollectedCentavos: number;
  shortageCentavos: number;
  overageCentavos: number;
  cashRemittedCentavos: number;
  remittanceStatus: RemittanceStatus | null;
  openedByName: string | null;
  submittedAt: string | null;
  remittedAt: string | null;
  reconciledAt: string | null;
  reconciledByName: string | null;
  closedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AgingBucketSummary {
  code: AgingBucketCode;
  label: string;
  invoiceCount: number;
  totalCentavos: number;
}

export interface AgingRowSummary {
  invoiceId: string;
  invoiceNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberAccountNumber: string;
  subscriberName: string;
  planName: string;
  serviceType: ServiceTypeCode;
  areaId: string | null;
  areaName: string | null;
  collectorId: string | null;
  collectorName: string | null;
  dueDate: string;
  ageDays: number;
  bucket: AgingBucketCode;
  monthsUnpaid: number;
  lastPaymentAt: string | null;
  balanceCentavos: number;
}

export interface AgingReport {
  buckets: AgingBucketSummary[];
  rows: AgingRowSummary[];
  totalOutstandingCentavos: number;
  totalOverdueCentavos: number;
  generatedAt: string;
}

export interface SuspensionSummary {
  id: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  reason: string;
  effectiveDate: string;
  status: SuspensionStatus;
  approvedByName: string | null;
  notes: string | null;
  createdAt: string;
  executedAt: string | null;
}

export interface ReconnectionSummary {
  id: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  suspensionId: string | null;
  feeCentavos: number;
  technicianName: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  status: ReconnectionStatus;
  approvedByName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface DashboardKpis {
  totalSubscribers: number;
  activeSubscribers: number;
  activeServiceAccounts: number;
  suspendedServiceAccounts: number;
  currentReceivableCentavos: number;
  overdueReceivableCentavos: number;
  advanceCreditCentavos: number;
  billedThisMonthCentavos: number;
  collectedThisMonthCentavos: number;
  collectionRatePercent: number;
  pendingGcashProofs: number;
  openBatches: number;
  pendingRemittanceCount: number;
  shortageCentavos: number;
  suspensionCandidates: number;
}

export interface PaymentMethodSummary {
  method: PaymentMethod;
  label: string;
  totalCentavos: number;
  count: number;
}

export interface DashboardResponse {
  kpis: DashboardKpis;
  aging: AgingBucketSummary[];
  paymentMethods: PaymentMethodSummary[];
  collectorPerformance: CollectorPerformanceRow[];
  recentPayments: PaymentSummary[];
  recentActivity: AuditEntrySummary[];
  overdueAlerts: OverdueAlertSummary[];
  generatedAt: string;
}

export interface CollectorPerformanceRow {
  collectorId: string;
  collectorName: string;
  expectedCentavos: number;
  collectedCentavos: number;
  uncollectedCentavos: number;
  cashCollectedCentavos: number;
  cashRemittedCentavos: number;
  nonCashCollectedCentavos: number;
  shortageCentavos: number;
  overageCentavos: number;
  collectionRatePercent: number;
  batchCount: number;
  accountCount: number;
}

export interface OverdueAlertSummary {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  contactNumber: string;
  areaName: string | null;
  collectorName: string | null;
  oldestUnpaidDueDate: string | null;
  monthsUnpaid: number;
  totalDueCentavos: number;
  ageDays: number;
}

export interface AuditEntrySummary {
  id: string;
  actorUsername: string;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface BackupRecordSummary {
  id: string;
  backupId: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  checksum: string | null;
  status: BackupStatus;
  createdByName: string | null;
  createdAt: string;
  verifiedAt: string | null;
  restoredAt: string | null;
  notes: string | null;
}

export interface ApplicationSettingSummary {
  key: string;
  value: unknown;
  valueLabel: string;
  description: string;
  category: string;
  updatedAt: string;
  updatedByName: string | null;
}

export interface StatementOfAccount {
  subscriber: Pick<
    SubscriberSummary,
    "id" | "accountNumber" | "fullName" | "contactNumber" | "addressLine" | "city"
  >;
  serviceAccount: Pick<
    ServiceAccountSummary,
    "id" | "serviceAccountNumber" | "planName" | "serviceType" | "billingDueDay" | "status"
  >;
  periodFrom: string;
  periodTo: string;
  openingBalanceCentavos: number;
  totalDebitCentavos: number;
  totalCreditCentavos: number;
  closingBalanceCentavos: number;
  entries: LedgerEntrySummary[];
  generatedAt: string;
}

export interface ReportDefinition {
  key: string;
  name: string;
  description: string;
  category: "COLLECTION" | "REVENUE" | "RECEIVABLES" | "SUBSCRIBER" | "COLLECTOR" | "AUDIT";
  permission: string;
}

export interface ExportResult {
  fileName: string;
  mimeType: string;
  format: "pdf" | "xlsx" | "csv";
  rowCount: number;
  base64: string;
}

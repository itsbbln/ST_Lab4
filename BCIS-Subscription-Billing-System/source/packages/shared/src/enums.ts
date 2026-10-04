export const serviceTypeCodes = ["INTERNET", "CABLE", "COMBO"] as const;
export type ServiceTypeCode = (typeof serviceTypeCodes)[number];

export const subscriberStatuses = ["ACTIVE", "INACTIVE", "TERMINATED", "ARCHIVED"] as const;
export type SubscriberStatus = (typeof subscriberStatuses)[number];

export const serviceAccountStatuses = [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "SUSPENDED",
  "DISCONNECTED",
  "TERMINATED"
] as const;
export type ServiceAccountStatus = (typeof serviceAccountStatuses)[number];

export const serviceEventTypes = [
  "CREATED",
  "ACTIVATED",
  "PLAN_CHANGED",
  "RATE_CHANGED",
  "SUSPENDED",
  "RECONNECTED",
  "DISCONNECTED",
  "TERMINATED",
  "ADDRESS_CHANGED",
  "COLLECTOR_CHANGED"
] as const;
export type ServiceEventType = (typeof serviceEventTypes)[number];

export const invoiceStatuses = [
  "DRAFT",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
  "CREDITED"
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const invoiceItemTypes = [
  "SUBSCRIPTION",
  "INSTALLATION",
  "RECONNECTION",
  "DISCOUNT",
  "PENALTY",
  "ADJUSTMENT_DEBIT",
  "ADJUSTMENT_CREDIT"
] as const;
export type InvoiceItemType = (typeof invoiceItemTypes)[number];

export const billingCycleStatuses = ["OPEN", "GENERATED", "FINALIZED", "CLOSED"] as const;
export type BillingCycleStatus = (typeof billingCycleStatuses)[number];

export const paymentMethods = ["CASH", "GCASH", "BANK_TRANSFER", "CHEQUE", "OTHER"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentStatuses = ["POSTED", "REVERSED"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const allocationTypes = ["AUTO", "MANUAL"] as const;
export type AllocationType = (typeof allocationTypes)[number];

export const proofStatuses = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type ProofStatus = (typeof proofStatuses)[number];

export const batchStatuses = [
  "OPEN",
  "IN_PROGRESS",
  "SUBMITTED",
  "REMITTED",
  "RECONCILED",
  "CLOSED"
] as const;
export type BatchStatus = (typeof batchStatuses)[number];

export const batchAccountStatuses = ["PENDING", "COLLECTED", "PARTIAL", "UNCOLLECTED", "SKIPPED"] as const;
export type BatchAccountStatus = (typeof batchAccountStatuses)[number];

export const remittanceStatuses = ["DRAFT", "SUBMITTED", "CONFIRMED", "REJECTED"] as const;
export type RemittanceStatus = (typeof remittanceStatuses)[number];

export const suspensionStatuses = ["PENDING", "APPROVED", "EXECUTED", "CANCELLED"] as const;
export type SuspensionStatus = (typeof suspensionStatuses)[number];

export const reconnectionStatuses = [
  "PENDING_PAYMENT",
  "REQUESTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED"
] as const;
export type ReconnectionStatus = (typeof reconnectionStatuses)[number];

export const backupStatuses = ["CREATED", "VERIFIED", "RESTORED", "FAILED"] as const;
export type BackupStatus = (typeof backupStatuses)[number];

export const agingBucketCodes = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketCode = (typeof agingBucketCodes)[number];

export const agingBucketLabels: Record<AgingBucketCode, string> = {
  CURRENT: "Current",
  D1_30: "1-30",
  D31_60: "31-60",
  D61_90: "61-90",
  D90_PLUS: "90+"
};

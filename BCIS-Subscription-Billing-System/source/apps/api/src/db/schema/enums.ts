import { pgEnum } from "drizzle-orm/pg-core";

import {
  allocationTypes,
  backupStatuses,
  batchAccountStatuses,
  batchStatuses,
  billingCycleStatuses,
  invoiceItemTypes,
  paymentMethods,
  paymentStatuses,
  proofStatuses,
  reconnectionStatuses,
  remittanceStatuses,
  serviceAccountStatuses,
  serviceEventTypes,
  serviceTypeCodes,
  subscriberStatuses,
  suspensionStatuses
} from "@bcis/shared";

export const serviceTypeEnum = pgEnum("service_type_code", serviceTypeCodes);
export const subscriberStatusEnum = pgEnum("subscriber_status", subscriberStatuses);
export const serviceAccountStatusEnum = pgEnum("service_account_status", serviceAccountStatuses);
export const serviceEventTypeEnum = pgEnum("service_event_type", serviceEventTypes);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "DRAFT",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
  "CREDITED"
]);
export const invoiceItemTypeEnum = pgEnum("invoice_item_type", invoiceItemTypes);
export const billingCycleStatusEnum = pgEnum("billing_cycle_status", billingCycleStatuses);
export const paymentMethodEnum = pgEnum("payment_method", paymentMethods);
export const paymentStatusEnum = pgEnum("payment_status", paymentStatuses);
export const allocationTypeEnum = pgEnum("allocation_type", allocationTypes);
export const proofStatusEnum = pgEnum("proof_status", proofStatuses);
export const batchStatusEnum = pgEnum("collection_batch_status", batchStatuses);
export const batchAccountStatusEnum = pgEnum("batch_account_status", batchAccountStatuses);
export const remittanceStatusEnum = pgEnum("remittance_status", remittanceStatuses);
export const suspensionStatusEnum = pgEnum("suspension_status", suspensionStatuses);
export const reconnectionStatusEnum = pgEnum("reconnection_status", reconnectionStatuses);
export const backupStatusEnum = pgEnum("backup_status", backupStatuses);

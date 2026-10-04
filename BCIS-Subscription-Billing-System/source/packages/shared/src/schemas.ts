import { z } from "zod";

import { parseCentavos } from "./money.js";
import {
  allocationTypes,
  batchAccountStatuses,
  batchStatuses,
  invoiceItemTypes,
  paymentMethods,
  proofStatuses,
  remittanceStatuses,
  serviceTypeCodes,
  subscriberStatuses
} from "./enums.js";

/** Accepts a peso string or number from a form and yields integer centavos. */
export const amountInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    try {
      return parseCentavos(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid amount." });
      return z.NEVER;
    }
  });

export const positiveAmountInput = amountInput.refine((centavos) => centavos > 0, {
  message: "Amount must be greater than zero."
});

export const nonNegativeAmountInput = amountInput.refine((centavos) => centavos >= 0, {
  message: "Amount cannot be negative."
});

export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Billing period must use the YYYY-MM format.");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use the YYYY-MM-DD format.");

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(25)
});

export const loginSchema = z.object({
  username: z.string().trim().min(3, "Username is required.").max(60),
  password: z.string().min(1, "Password is required.").max(200)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(8, "New password must be at least 8 characters.").max(200)
});

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters.")
    .max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may only contain letters, numbers, dot, underscore and hyphen."),
  displayName: z.string().trim().min(3, "Display name is required.").max(120),
  email: z.string().trim().email("Enter a valid email address.").max(160).optional(),
  password: z.string().min(8, "Password must be at least 8 characters.").max(200),
  roleCodes: z.array(z.string().min(1)).min(1, "Assign at least one role."),
  isActive: z.boolean().default(true)
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(3).max(120).optional(),
  email: z.string().trim().email().max(160).nullable().optional(),
  isActive: z.boolean().optional(),
  roleCodes: z.array(z.string().min(1)).min(1).optional()
});

export const upsertPlanSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Plan code is required.")
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, "Plan code may only contain letters, numbers, dot, underscore and hyphen."),
  name: z.string().trim().min(3, "Plan name is required.").max(120),
  serviceType: z.enum(serviceTypeCodes),
  monthlyPrice: positiveAmountInput,
  installationFee: nonNegativeAmountInput.default(0),
  reconnectionFee: nonNegativeAmountInput.default(0),
  speedMbps: z.coerce.number().int().min(0).max(100_000).nullable().optional(),
  channelCount: z.coerce.number().int().min(0).max(1_000).nullable().optional(),
  description: z.string().trim().max(500).default(""),
  isActive: z.boolean().default(true)
});

export const upsertSubscriberSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .min(3, "Account number is required.")
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Account number may only contain letters, numbers, dot, underscore and hyphen."),
  fullName: z.string().trim().min(3, "Full name is required.").max(120),
  contactNumber: z
    .string()
    .trim()
    .min(7, "Contact number is required.")
    .max(30)
    .regex(/^[0-9+\-\s()]+$/, "Contact number may only contain digits and phone separators."),
  email: z.string().trim().email().max(160).optional(),
  addressLine: z.string().trim().min(5, "Address is required.").max(240),
  city: z.string().trim().min(2, "City is required.").max(120),
  collectionAreaId: z.string().min(1, "Assign a collection area."),
  notes: z.string().trim().max(500).optional(),
  status: z.enum(subscriberStatuses).default("ACTIVE")
});

export const updateSubscriberSchema = upsertSubscriberSchema.partial();

export const upsertAddressSchema = z.object({
  label: z.string().trim().min(2, "Address label is required.").max(60),
  addressLine: z.string().trim().min(5, "Address is required.").max(240),
  city: z.string().trim().min(2, "City is required.").max(120),
  isPrincipal: z.boolean().default(false)
});

export const upsertServiceAccountSchema = z.object({
  subscriberId: z.string().min(1, "Select a subscriber."),
  planId: z.string().min(1, "Select a plan."),
  installationAddress: z.string().trim().min(5, "Installation address is required.").max(240),
  collectorId: z.string().min(1, "Assign a collector.").nullable().optional(),
  activationDate: isoDateSchema,
  billingStartPeriod: periodSchema,
  billingDueDay: z.coerce.number().int().min(1, "Due day must be between 1 and 28.").max(28),
  status: z.enum(["PENDING_ACTIVATION", "ACTIVE", "SUSPENDED", "DISCONNECTED", "TERMINATED"]).default("PENDING_ACTIVATION"),
  notes: z.string().trim().max(500).optional()
});

export const changePlanSchema = z.object({
  planId: z.string().min(1, "Select a plan."),
  effectivePeriod: periodSchema,
  reason: z.string().trim().min(3, "A reason is required.").max(300)
});

export const generateBillingSchema = z.object({
  period: periodSchema,
  applyPenalty: z.boolean().default(false)
});

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(5, "A void reason of at least 5 characters is required.").max(300)
});

export const allocationPreviewSchema = z.object({
  serviceAccountId: z.string().min(1),
  amount: positiveAmountInput
});

export const allocationLineSchema = z.object({
  invoiceId: z.string().min(1),
  amount: positiveAmountInput
});

export const createPaymentSchema = z.object({
  serviceAccountId: z.string().min(1, "Select a service account."),
  amount: positiveAmountInput,
  method: z.enum(paymentMethods),
  referenceNumber: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  collectorId: z.string().min(1).nullable().optional(),
  batchAccountId: z.string().min(1).nullable().optional(),
  manualAllocations: z.array(allocationLineSchema).max(200).optional(),
  useAccountCredit: z.boolean().default(false)
});

export const reversePaymentSchema = z.object({
  paymentId: z.string().min(1),
  reason: z.string().trim().min(5, "A reversal reason of at least 5 characters is required.").max(300)
});

export const submitGcashProofSchema = z.object({
  serviceAccountId: z.string().min(1, "Select a service account."),
  amount: positiveAmountInput,
  referenceNumber: z
    .string()
    .trim()
    .min(4, "GCash reference number is required.")
    .max(120)
    .regex(/^[A-Za-z0-9-]+$/, "GCash reference may only contain letters, numbers and hyphens."),
  senderName: z.string().trim().min(3, "Sender name is required.").max(120),
  proofNote: z.string().trim().max(500).optional(),
  attachmentId: z.string().min(1).nullable().optional()
});

export const verifyGcashProofSchema = z.object({
  proofId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().trim().max(300).optional()
});

export const upsertCollectionAreaSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Area code is required.")
    .max(30)
    .regex(/^[A-Za-z0-9._-]+$/, "Area code may only contain letters, numbers, dot, underscore and hyphen."),
  name: z.string().trim().min(3, "Area name is required.").max(120),
  description: z.string().trim().max(500).default(""),
  isActive: z.boolean().default(true)
});

export const upsertCollectionRouteSchema = z.object({
  areaId: z.string().min(1, "Select an area."),
  code: z
    .string()
    .trim()
    .min(2, "Route code is required.")
    .max(30)
    .regex(/^[A-Za-z0-9._-]+$/, "Route code may only contain letters, numbers, dot, underscore and hyphen."),
  name: z.string().trim().min(3, "Route name is required.").max(120),
  description: z.string().trim().max(500).default(""),
  isActive: z.boolean().default(true)
});

export const upsertCollectorSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Collector code is required.")
    .max(30)
    .regex(/^[A-Za-z0-9._-]+$/, "Collector code may only contain letters, numbers, dot, underscore and hyphen."),
  fullName: z.string().trim().min(3, "Collector name is required.").max(120),
  contactNumber: z
    .string()
    .trim()
    .min(7, "Contact number is required.")
    .max(30)
    .regex(/^[0-9+\-\s()]+$/, "Contact number may only contain digits and phone separators."),
  isActive: z.boolean().default(true)
});

export const assignCollectorSchema = z.object({
  collectorId: z.string().min(1, "Select a collector."),
  routeId: z.string().min(1, "Select a route.").nullable().optional(),
  effectiveFrom: isoDateSchema,
  notes: z.string().trim().max(300).optional()
});

export const createBatchSchema = z.object({
  areaId: z.string().min(1, "Select an area."),
  routeId: z.string().min(1).nullable().optional(),
  collectorId: z.string().min(1, "Select a collector."),
  batchDate: isoDateSchema,
  dueDayCutoff: z.coerce.number().int().min(0).max(31).default(31),
  notes: z.string().trim().max(500).optional()
});

export const addBatchAccountsSchema = z.object({
  serviceAccountIds: z.array(z.string().min(1)).min(1, "Select at least one service account.").max(500)
});

export const recordCollectionSchema = z.object({
  batchAccountId: z.string().min(1),
  amount: nonNegativeAmountInput,
  status: z.enum(batchAccountStatuses),
  /**
   * Doorstep collection is cash by default. A collector may also settle in
   * GCash or by transfer at the door, and the batch summary reports those
   * separately from cash the collector has to remit.
   */
  method: z.enum(paymentMethods).default("CASH"),
  notes: z.string().trim().max(300).optional()
});

export const transitionBatchSchema = z.object({
  toStatus: z.enum(batchStatuses),
  notes: z.string().trim().max(500).optional()
});

export const createRemittanceSchema = z.object({
  batchId: z.string().min(1),
  cashRemitted: nonNegativeAmountInput,
  nonCashCollected: nonNegativeAmountInput,
  remarks: z.string().trim().max(500).optional()
});

export const confirmRemittanceSchema = z.object({
  remittanceId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().trim().min(5, "A reason of at least 5 characters is required.").max(300)
});

export const recordSuspensionSchema = z.object({
  serviceAccountIds: z.array(z.string().min(1)).min(1, "Select at least one service account.").max(200),
  reason: z.string().trim().min(5, "A suspension reason of at least 5 characters is required.").max(300),
  effectiveDate: isoDateSchema,
  notes: z.string().trim().max(500).optional()
});

export const executeSuspensionSchema = z.object({
  suspensionId: z.string().min(1),
  notes: z.string().trim().max(500).optional()
});

export const requestReconnectionSchema = z.object({
  serviceAccountId: z.string().min(1),
  technicianId: z.string().min(1, "Assign a technician.").nullable().optional(),
  notes: z.string().trim().max(500).optional()
});

export const completeReconnectionSchema = z.object({
  reconnectionId: z.string().min(1),
  notes: z.string().trim().max(500).optional()
});

export const upsertSettingSchema = z.object({
  value: z.unknown(),
  description: z.string().trim().max(300).optional()
});

export const reportQuerySchema = paginationSchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  areaId: z.string().min(1).optional(),
  collectorId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  serviceType: z.enum(serviceTypeCodes).optional(),
  method: z.enum(paymentMethods).optional(),
  exportFormat: z.enum(["pdf", "xlsx", "csv"]).optional()
});

export const ledgerQuerySchema = paginationSchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional()
});

export const overdueQuerySchema = paginationSchema.extend({
  areaId: z.string().min(1).optional(),
  collectorId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  serviceType: z.enum(serviceTypeCodes).optional(),
  minAgeDays: z.coerce.number().int().min(0).max(3650).optional()
});

export const searchSchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional()
});

export const voidReceiptSchema = z.object({
  reason: z.string().trim().min(5, "A void reason of at least 5 characters is required.").max(300)
});

export const proofStatusFilterSchema = z.object({
  status: z.enum(proofStatuses).optional()
});

export const allocationTypeFilterSchema = z.object({
  type: z.enum(allocationTypes).optional()
});

export const invoiceItemTypeFilterSchema = z.object({
  type: z.enum(invoiceItemTypes).optional()
});

export const remittanceStatusFilterSchema = z.object({
  status: z.enum(remittanceStatuses).optional()
});

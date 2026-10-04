import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { formatCentavos } from "@bcis/shared";

import type { Executor } from "../db/client.js";
import {
  billingCycles,
  collectionAreas,
  collectionRoutes,
  collectors,
  invoices,
  payments,
  paymentProofs,
  serviceAccounts,
  serviceDevices,
  serviceEvents,
  servicePlans,
  serviceTypes,
  subscriberAddresses,
  subscribers,
  technicians
} from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { DomainError, businessRule, notFound } from "./errors.js";
import { nextDocument } from "./numbering.js";
import type { Actor } from "./types.js";

/**
 * Reference data and the subscriber master file (§3.2, §3.3).
 *
 * Two rules from the guide drive the design here:
 *
 *  - Subscribers are never deleted. §3.2 requires historical accounts to be
 *    preserved, so the only supported state change is a status move towards
 *    INACTIVE / TERMINATED / ARCHIVED, and every change is audited.
 *  - A plan price change must not rewrite history (§3.3). `service_accounts.
 *    current_rate_centavos` is a snapshot taken at activation; the billing
 *    engine reads that snapshot, never `service_plans.monthly_price_centavos`.
 */

// ---------------------------------------------------------------------------
// Service catalogue
// ---------------------------------------------------------------------------

export async function ensureServiceTypes(executor: Executor): Promise<void> {
  const rows = [
    { code: "INTERNET", name: "Internet", description: "Broadband internet subscription" },
    { code: "CABLE", name: "Cable", description: "Cable television subscription" },
    { code: "COMBO", name: "Combo", description: "Bundled internet and cable subscription" }
  ];
  await executor.insert(serviceTypes).values(rows).onConflictDoNothing();
}

export interface PlanInput {
  code: string;
  name: string;
  serviceType: "INTERNET" | "CABLE" | "COMBO";
  monthlyPrice: number;
  installationFee: number;
  reconnectionFee: number;
  speedMbps?: number | null;
  channelCount?: number | null;
  description: string;
  isActive: boolean;
}

export async function listPlans(executor: Executor, options: { activeOnly?: boolean } = {}) {
  return executor
    .select({
      id: servicePlans.id,
      code: servicePlans.code,
      name: servicePlans.name,
      serviceType: serviceTypes.code,
      serviceTypeName: serviceTypes.name,
      monthlyPriceCentavos: servicePlans.monthlyPriceCentavos,
      installationFeeCentavos: servicePlans.installationFeeCentavos,
      reconnectionFeeCentavos: servicePlans.reconnectionFeeCentavos,
      speedMbps: servicePlans.speedMbps,
      channelCount: servicePlans.channelCount,
      description: servicePlans.description,
      isActive: servicePlans.isActive,
      updatedAt: servicePlans.updatedAt
    })
    .from(servicePlans)
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(options.activeOnly ? eq(servicePlans.isActive, true) : undefined)
    .orderBy(asc(serviceTypes.code), asc(servicePlans.monthlyPriceCentavos));
}

async function serviceTypeId(executor: Executor, code: string): Promise<string> {
  const rows = await executor
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(eq(serviceTypes.code, code))
    .limit(1);
  if (!rows[0]) {
    throw businessRule(`Service type ${code} is not set up.`);
  }
  return rows[0].id;
}

export async function createPlan(executor: Executor, input: PlanInput, actor?: Actor) {
  const typeId = await serviceTypeId(executor, input.serviceType);
  const [plan] = await executor
    .insert(servicePlans)
    .values({
      code: input.code,
      name: input.name,
      serviceTypeId: typeId,
      monthlyPriceCentavos: input.monthlyPrice,
      installationFeeCentavos: input.installationFee,
      reconnectionFeeCentavos: input.reconnectionFee,
      speedMbps: input.speedMbps ?? null,
      channelCount: input.channelCount ?? null,
      description: input.description,
      isActive: input.isActive,
      createdBy: actor?.id ?? null,
      updatedBy: actor?.id ?? null
    })
    .returning();

  await writeAudit(executor, actor, {
    action: auditActions.PLAN_CREATED,
    entityType: "service_plan",
    entityId: plan.id,
    changes: {
      code: { new: plan.code },
      monthlyPriceCentavos: { new: plan.monthlyPriceCentavos }
    }
  });
  return plan;
}

export async function updatePlan(
  executor: Executor,
  planId: string,
  input: Partial<PlanInput>,
  actor?: Actor
) {
  const existing = await executor
    .select()
    .from(servicePlans)
    .where(eq(servicePlans.id, planId))
    .limit(1);
  const before = existing[0];
  if (!before) {
    throw notFound("Plan", planId);
  }

  const typeId = input.serviceType ? await serviceTypeId(executor, input.serviceType) : before.serviceTypeId;
  const [after] = await executor
    .update(servicePlans)
    .set({
      name: input.name ?? before.name,
      serviceTypeId: typeId,
      monthlyPriceCentavos: input.monthlyPrice ?? before.monthlyPriceCentavos,
      installationFeeCentavos: input.installationFee ?? before.installationFeeCentavos,
      reconnectionFeeCentavos: input.reconnectionFee ?? before.reconnectionFeeCentavos,
      speedMbps: input.speedMbps === undefined ? before.speedMbps : input.speedMbps,
      channelCount: input.channelCount === undefined ? before.channelCount : input.channelCount,
      description: input.description ?? before.description,
      isActive: input.isActive ?? before.isActive,
      updatedBy: actor?.id ?? null,
      updatedAt: new Date()
    })
    .where(eq(servicePlans.id, planId))
    .returning();

  await writeAudit(executor, actor, {
    action: auditActions.PLAN_UPDATED,
    entityType: "service_plan",
    entityId: planId,
    changes: {
      monthlyPriceCentavos: {
        old: before.monthlyPriceCentavos,
        new: after.monthlyPriceCentavos
      },
      isActive: { old: before.isActive, new: after.isActive }
    },
    // Explicitly recorded that existing accounts keep their rate snapshot.
    metadata: { affectsFutureBillingOnly: true }
  });
  return after;
}

// ---------------------------------------------------------------------------
// Collection topology
// ---------------------------------------------------------------------------

export async function listCollectionAreas(executor: Executor, options: { activeOnly?: boolean } = {}) {
  return executor
    .select()
    .from(collectionAreas)
    .where(options.activeOnly ? eq(collectionAreas.isActive, true) : undefined)
    .orderBy(asc(collectionAreas.code));
}

/**
 * Reference data (areas, routes, collectors, technicians) is keyed by a
 * case-insensitive unique index on `code`. Drizzle cannot express a conflict
 * target for an expression index, so these upserts read first and then insert or
 * update. That is safe here because reference rows are administrative data
 * edited by a handful of users, never on a financial hot path.
 */
async function findByCode<TTable extends { code: { name: string } }>(
  executor: Executor,
  table: TTable,
  code: string
): Promise<{ id: string } | undefined> {
  const rows = await executor
    .select({ id: sql<string>`${(table as unknown as { id: unknown }).id}` })
    .from(table as never)
    .where(sql`lower(${(table as unknown as { code: unknown }).code}) = lower(${code})`)
    .limit(1);
  return rows[0];
}

export async function upsertCollectionArea(
  executor: Executor,
  input: { code: string; name: string; description: string; isActive: boolean },
  actor?: Actor
) {
  const existing = await findByCode(executor, collectionAreas, input.code);
  if (existing) {
    const [area] = await executor
      .update(collectionAreas)
      .set({
        name: input.name,
        description: input.description,
        isActive: input.isActive
      })
      .where(eq(collectionAreas.id, existing.id))
      .returning();
    return area;
  }
  const [area] = await executor.insert(collectionAreas).values(input).returning();
  return area;
}

export async function listCollectionRoutes(executor: Executor, areaId?: string) {
  return executor
    .select({
      id: collectionRoutes.id,
      code: collectionRoutes.code,
      name: collectionRoutes.name,
      description: collectionRoutes.description,
      isActive: collectionRoutes.isActive,
      areaId: collectionRoutes.areaId,
      areaName: collectionAreas.name
    })
    .from(collectionRoutes)
    .innerJoin(collectionAreas, eq(collectionRoutes.areaId, collectionAreas.id))
    .where(areaId ? eq(collectionRoutes.areaId, areaId) : undefined)
    .orderBy(asc(collectionRoutes.code));
}

export async function upsertCollectionRoute(
  executor: Executor,
  input: {
    areaId: string;
    code: string;
    name: string;
    description: string;
    isActive: boolean;
  }
) {
  const existing = await findByCode(executor, collectionRoutes, input.code);
  if (existing) {
    const [route] = await executor
      .update(collectionRoutes)
      .set({
        areaId: input.areaId,
        name: input.name,
        description: input.description,
        isActive: input.isActive
      })
      .where(eq(collectionRoutes.id, existing.id))
      .returning();
    return route;
  }
  const [route] = await executor.insert(collectionRoutes).values(input).returning();
  return route;
}

export async function listCollectors(executor: Executor, options: { activeOnly?: boolean } = {}) {
  return executor
    .select()
    .from(collectors)
    .where(options.activeOnly ? eq(collectors.isActive, true) : undefined)
    .orderBy(asc(collectors.code));
}

export async function upsertCollector(
  executor: Executor,
  input: { code: string; fullName: string; contactNumber: string; isActive: boolean }
) {
  const existing = await findByCode(executor, collectors, input.code);
  if (existing) {
    const [collector] = await executor
      .update(collectors)
      .set({
        fullName: input.fullName,
        contactNumber: input.contactNumber,
        isActive: input.isActive
      })
      .where(eq(collectors.id, existing.id))
      .returning();
    return collector;
  }
  const [collector] = await executor.insert(collectors).values(input).returning();
  return collector;
}

export async function listTechnicians(executor: Executor) {
  return executor.select().from(technicians).orderBy(asc(technicians.code));
}

export async function upsertTechnician(
  executor: Executor,
  input: { code: string; fullName: string; contactNumber: string; isActive: boolean }
) {
  const existing = await findByCode(executor, technicians, input.code);
  if (existing) {
    const [technician] = await executor
      .update(technicians)
      .set({
        fullName: input.fullName,
        contactNumber: input.contactNumber,
        isActive: input.isActive
      })
      .where(eq(technicians.id, existing.id))
      .returning();
    return technician;
  }
  const [technician] = await executor.insert(technicians).values(input).returning();
  return technician;
}

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

export interface SubscriberInput {
  accountNumber: string;
  fullName: string;
  contactNumber: string;
  email?: string | null;
  addressLine: string;
  city: string;
  collectionAreaId: string;
  notes?: string | null;
  status: "ACTIVE" | "INACTIVE" | "TERMINATED" | "ARCHIVED";
}

export async function createSubscriber(
  executor: Executor,
  input: SubscriberInput,
  actor?: Actor
) {
  const [subscriber] = await executor
    .insert(subscribers)
    .values({
      accountNumber: input.accountNumber,
      fullName: input.fullName,
      contactNumber: input.contactNumber,
      email: input.email ?? null,
      addressLine: input.addressLine,
      city: input.city,
      collectionAreaId: input.collectionAreaId,
      notes: input.notes ?? null,
      status: input.status,
      createdBy: actor?.id ?? null,
      updatedBy: actor?.id ?? null
    })
    .returning();

  // The principal service address is stored both on the subscriber row (for
  // fast search) and as a first-class address row, so a subscriber can hold
  // several service addresses (§3.2).
  await executor.insert(subscriberAddresses).values({
    subscriberId: subscriber.id,
    label: "Principal Address",
    addressLine: input.addressLine,
    city: input.city,
    isPrincipal: true
  });

  await writeAudit(executor, actor, {
    action: auditActions.SUBSCRIBER_CREATED,
    entityType: "subscriber",
    entityId: subscriber.id,
    changes: {
      accountNumber: { new: subscriber.accountNumber },
      fullName: { new: subscriber.fullName }
    }
  });
  return subscriber;
}

export async function updateSubscriber(
  executor: Executor,
  subscriberId: string,
  input: Partial<SubscriberInput>,
  actor?: Actor
) {
  const existing = await executor
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .limit(1);
  const before = existing[0];
  if (!before) {
    throw notFound("Subscriber", subscriberId);
  }

  const [after] = await executor
    .update(subscribers)
    .set({
      fullName: input.fullName ?? before.fullName,
      contactNumber: input.contactNumber ?? before.contactNumber,
      email: input.email === undefined ? before.email : input.email,
      addressLine: input.addressLine ?? before.addressLine,
      city: input.city ?? before.city,
      collectionAreaId: input.collectionAreaId ?? before.collectionAreaId,
      notes: input.notes === undefined ? before.notes : input.notes,
      status: input.status ?? before.status,
      updatedBy: actor?.id ?? null,
      updatedAt: new Date()
    })
    .where(eq(subscribers.id, subscriberId))
    .returning();

  const terminalStatuses = ["TERMINATED", "ARCHIVED"] as const;
  const goingTerminal = input.status && terminalStatuses.includes(input.status as never);
  const wasLive = before.status === "ACTIVE" || before.status === "INACTIVE";

  if (goingTerminal && wasLive) {
    // A terminated subscriber must not keep a live service line. The service
    // accounts are moved to TERMINATED rather than deleted, and each one gets a
    // service_event, so the service history stays complete (§3.2, §3.10).
    const live = await executor
      .select({ id: serviceAccounts.id, serviceAccountNumber: serviceAccounts.serviceAccountNumber })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.subscriberId, subscriberId),
          inArray(serviceAccounts.status, ["ACTIVE", "PENDING_ACTIVATION", "SUSPENDED"])
        )
      );

    for (const account of live) {
      await executor
        .update(serviceAccounts)
        .set({ status: "TERMINATED", updatedAt: new Date() })
        .where(eq(serviceAccounts.id, account.id));
      await executor.insert(serviceEvents).values({
        serviceAccountId: account.id,
        eventType: "TERMINATED",
        reason: `Subscriber ${before.accountNumber} moved to ${input.status}`,
        effectiveDate: new Date().toISOString().slice(0, 10),
        actorId: actor?.id ?? null,
        actorName: actor?.displayName ?? null
      });
    }
  }

  await writeAudit(executor, actor, {
    action: auditActions.SUBSCRIBER_UPDATED,
    entityType: "subscriber",
    entityId: subscriberId,
    changes:
      input.status && input.status !== before.status
        ? { status: { old: before.status, new: after.status } }
        : { fullName: { old: before.fullName, new: after.fullName } }
  });
  return after;
}

export async function addSubscriberAddress(
  executor: Executor,
  subscriberId: string,
  input: { label: string; addressLine: string; city: string; isPrincipal: boolean }
) {
  if (input.isPrincipal) {
    await executor
      .update(subscriberAddresses)
      .set({ isPrincipal: false })
      .where(eq(subscriberAddresses.subscriberId, subscriberId));
  }
  const [address] = await executor
    .insert(subscriberAddresses)
    .values({ subscriberId, ...input })
    .returning();
  return address;
}

export async function listSubscriberAddresses(executor: Executor, subscriberId: string) {
  return executor
    .select()
    .from(subscriberAddresses)
    .where(eq(subscriberAddresses.subscriberId, subscriberId))
    .orderBy(desc(subscriberAddresses.isPrincipal), asc(subscriberAddresses.label));
}

export interface SubscriberSearch {
  q?: string;
  status?: string;
  areaId?: string;
  page: number;
  pageSize: number;
}

/**
 * Global search (§3.2): one box that finds an account by number, name, contact
 * number, address, receipt number, invoice number or GCash reference.
 */
export async function searchSubscribers(executor: Executor, query: SubscriberSearch) {
  const filters = [];
  if (query.status) {
    filters.push(eq(subscribers.status, query.status as never));
  }
  if (query.areaId) {
    filters.push(eq(subscribers.collectionAreaId, query.areaId));
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    const digitTail = query.q.replace(/\D/g, "").slice(-10);

    // A search for a document number resolves to the owning subscriber, so a
    // cashier can paste a receipt, invoice or GCash reference straight into the
    // same search box (§3.2).
    const accountsMatchingDocument = sql`exists (
      select 1 from ${serviceAccounts} sa
      where sa.subscriber_id = ${subscribers.id} and (
        sa.service_account_number ilike ${`%${query.q}%`}
        or sa.installation_address ilike ${pattern}
        or exists (select 1 from ${payments} p
                   where p.service_account_id = sa.id and p.receipt_number ilike ${`%${query.q}%`})
        or exists (select 1 from ${invoices} i
                   where i.service_account_id = sa.id and i.invoice_number ilike ${`%${query.q}%`})
        or exists (select 1 from ${paymentProofs} pp
                   where pp.service_account_id = sa.id and pp.reference_number ilike ${`%${query.q}%`})
      )
    )`;

    const directFilters = [
      ilike(subscribers.accountNumber, `%${query.q}%`),
      ilike(subscribers.fullName, pattern),
      ilike(subscribers.addressLine, pattern),
      ilike(subscribers.city, pattern),
      accountsMatchingDocument
    ];
    if (digitTail.length >= 4) {
      // Match on the last digits so "0917 123 4567" and "1234567" both find the
      // subscriber regardless of how the number was stored.
      directFilters.push(sql`right(${subscribers.contactNumber}, ${digitTail.length}) = ${digitTail}`);
    }
    filters.push(or(...directFilters)!);
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await executor.select({ value: count() }).from(subscribers).where(where);
  const rows = await executor
    .select({
      id: subscribers.id,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      contactNumber: subscribers.contactNumber,
      addressLine: subscribers.addressLine,
      city: subscribers.city,
      status: subscribers.status,
      areaId: subscribers.collectionAreaId,
      areaName: collectionAreas.name,
      serviceAccountCount: sql<number>`(
        select count(*)::int from ${serviceAccounts} where ${serviceAccounts.subscriberId} = ${subscribers.id}
      )`,
      // `::bigint` is required, not cosmetic. `sum()` over a `bigint` column
      // yields `numeric`, which node-postgres hands back as a *string*, so the
      // declared `sql<number>` would be a lie and `formatCentavos` would reject
      // the value. Casting to `bigint` lets the INT8 parser in db/client.ts
      // produce a real number. Without this the whole list 500s the moment a
      // subscriber has no arrears, because "0" is not an integer.
      outstandingCentavos: sql<number>`coalesce((
        select sum(${invoices.balanceCentavos}) from ${invoices}
        join ${serviceAccounts} on ${invoices.serviceAccountId} = ${serviceAccounts.id}
        where ${serviceAccounts.subscriberId} = ${subscribers.id} and ${invoices.balanceCentavos} > 0
      ), 0)::bigint`
    })
    .from(subscribers)
    .innerJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .where(where)
    .orderBy(asc(subscribers.fullName))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({
      ...row,
      outstanding: formatCentavos(row.outstandingCentavos, { blankZero: true })
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0
  };
}

export async function getSubscriber(executor: Executor, subscriberId: string) {
  const rows = await executor
    .select({
      id: subscribers.id,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      contactNumber: subscribers.contactNumber,
      email: subscribers.email,
      addressLine: subscribers.addressLine,
      city: subscribers.city,
      status: subscribers.status,
      notes: subscribers.notes,
      billingDueDay: subscribers.billingDueDay,
      createdAt: subscribers.createdAt,
      areaId: subscribers.collectionAreaId,
      areaName: collectionAreas.name,
      areaCode: collectionAreas.code
    })
    .from(subscribers)
    .innerJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .where(eq(subscribers.id, subscriberId))
    .limit(1);
  if (!rows[0]) {
    throw notFound("Subscriber", subscriberId);
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Service accounts
// ---------------------------------------------------------------------------

export interface ServiceAccountInput {
  subscriberId: string;
  planId: string;
  installationAddress: string;
  collectorId?: string | null;
  activationDate: string;
  billingStartPeriod: string;
  billingDueDay: number;
  status: "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED" | "DISCONNECTED" | "TERMINATED";
  notes?: string | null;
}

export async function createServiceAccount(
  executor: Executor,
  input: ServiceAccountInput,
  actor?: Actor
) {
  const planRows = await executor
    .select()
    .from(servicePlans)
    .where(eq(servicePlans.id, input.planId))
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    throw notFound("Plan", input.planId);
  }
  if (!plan.isActive) {
    throw businessRule(`Plan ${plan.code} is inactive and cannot be assigned to a new account.`);
  }

  const year = new Date().getUTCFullYear();
  const serviceAccountNumber = await nextDocument(executor, "SERVICE_ACCOUNT", year);

  const [account] = await executor
    .insert(serviceAccounts)
    .values({
      serviceAccountNumber,
      subscriberId: input.subscriberId,
      planId: input.planId,
      installationAddress: input.installationAddress,
      activationDate: input.activationDate,
      billingStartPeriod: input.billingStartPeriod,
      billingDueDay: input.billingDueDay,
      // Rate snapshot: future plan price changes will not rewrite this.
      currentRateCentavos: plan.monthlyPriceCentavos,
      status: input.status,
      collectorId: input.collectorId ?? null,
      notes: input.notes ?? null,
      createdBy: actor?.id ?? null
    })
    .returning();

  await executor.insert(serviceEvents).values([
    {
      serviceAccountId: account.id,
      eventType: "CREATED",
      reason: `Account created on plan ${plan.code}`,
      effectiveDate: input.activationDate,
      actorId: actor?.id ?? null,
      actorName: actor?.displayName ?? null,
      metadata: JSON.stringify({ planId: plan.id, rateCentavos: plan.monthlyPriceCentavos })
    },
    ...(input.status === "ACTIVE"
      ? [
          {
            serviceAccountId: account.id,
            eventType: "ACTIVATED" as const,
            reason: "Service activated",
            effectiveDate: input.activationDate,
            actorId: actor?.id ?? null,
            actorName: actor?.displayName ?? null
          }
        ]
      : [])
  ]);

  await writeAudit(executor, actor, {
    action: auditActions.SERVICE_ACCOUNT_CREATED,
    entityType: "service_account",
    entityId: account.id,
    changes: {
      serviceAccountNumber: { new: serviceAccountNumber },
      planId: { new: plan.id },
      currentRateCentavos: { new: plan.monthlyPriceCentavos }
    }
  });
  return account;
}

export interface ServiceAccountListQuery {
  q?: string;
  subscriberId?: string;
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export async function listServiceAccounts(executor: Executor, query: ServiceAccountListQuery) {
  const filters = [];
  if (query.subscriberId) {
    filters.push(eq(serviceAccounts.subscriberId, query.subscriberId));
  }
  if (query.collectorId) {
    filters.push(eq(serviceAccounts.collectorId, query.collectorId));
  }
  if (query.planId) {
    filters.push(eq(serviceAccounts.planId, query.planId));
  }
  if (query.serviceType) {
    filters.push(eq(serviceTypes.code, query.serviceType as never));
  }
  if (query.status) {
    filters.push(eq(serviceAccounts.status, query.status as never));
  }
  if (query.areaId) {
    filters.push(eq(subscribers.collectionAreaId, query.areaId));
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(
      or(
        ilike(serviceAccounts.serviceAccountNumber, `%${query.q}%`),
        ilike(subscribers.fullName, pattern),
        ilike(subscribers.accountNumber, `%${query.q}%`),
        ilike(serviceAccounts.installationAddress, pattern)
      )!
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await executor
    .select({ value: count() })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(where);

  const rows = await executor
    .select({
      id: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      status: serviceAccounts.status,
      installationAddress: serviceAccounts.installationAddress,
      activationDate: serviceAccounts.activationDate,
      billingStartPeriod: serviceAccounts.billingStartPeriod,
      billingDueDay: serviceAccounts.billingDueDay,
      currentRateCentavos: serviceAccounts.currentRateCentavos,
      creditBalanceCentavos: serviceAccounts.creditBalanceCentavos,
      subscriberId: subscribers.id,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber,
      planId: servicePlans.id,
      planName: servicePlans.name,
      serviceType: serviceTypes.code,
      areaId: subscribers.collectionAreaId,
      areaName: collectionAreas.name,
      collectorId: serviceAccounts.collectorId,
      collectorName: collectors.fullName,
      // See the note on `outstandingCentavos` above: the `::bigint` cast is what
      // keeps this a number instead of a numeric-as-string.
      outstandingCentavos: sql<number>`coalesce((
        select sum(${invoices.balanceCentavos}) from ${invoices}
        where ${invoices.serviceAccountId} = ${serviceAccounts.id} and ${invoices.balanceCentavos} > 0
      ), 0)::bigint`
    })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .leftJoin(collectors, eq(serviceAccounts.collectorId, collectors.id))
    .where(where)
    .orderBy(asc(subscribers.fullName), asc(serviceAccounts.serviceAccountNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({ ...row, outstanding: formatCentavos(row.outstandingCentavos, { blankZero: true }) })),
    page: query.page,
    pageSize: query.pageSize,
    total: totalRow?.value ?? 0
  };
}

export async function getServiceAccount(executor: Executor, serviceAccountId: string) {
  const rows = await executor
    .select({
      id: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      status: serviceAccounts.status,
      installationAddress: serviceAccounts.installationAddress,
      activationDate: serviceAccounts.activationDate,
      billingStartPeriod: serviceAccounts.billingStartPeriod,
      billingDueDay: serviceAccounts.billingDueDay,
      currentRateCentavos: serviceAccounts.currentRateCentavos,
      creditBalanceCentavos: serviceAccounts.creditBalanceCentavos,
      notes: serviceAccounts.notes,
      subscriberId: subscribers.id,
      subscriberName: subscribers.fullName,
      accountNumber: subscribers.accountNumber,
      contactNumber: subscribers.contactNumber,
      subscriberStatus: subscribers.status,
      planId: servicePlans.id,
      planName: servicePlans.name,
      planCode: servicePlans.code,
      serviceType: serviceTypes.code,
      reconnectionFeeCentavos: servicePlans.reconnectionFeeCentavos,
      installationFeeCentavos: servicePlans.installationFeeCentavos,
      areaId: collectionAreas.id,
      areaName: collectionAreas.name,
      collectorId: serviceAccounts.collectorId,
      collectorName: collectors.fullName
    })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .leftJoin(collectors, eq(serviceAccounts.collectorId, collectors.id))
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);

  const account = rows[0];
  if (!account) {
    throw notFound("Service account", serviceAccountId);
  }
  return account;
}

export async function listServiceEvents(executor: Executor, serviceAccountId: string) {
  return executor
    .select()
    .from(serviceEvents)
    .where(eq(serviceEvents.serviceAccountId, serviceAccountId))
    .orderBy(desc(serviceEvents.effectiveDate), desc(serviceEvents.createdAt));
}

export async function listServiceDevices(executor: Executor, serviceAccountId: string) {
  return executor
    .select()
    .from(serviceDevices)
    .where(eq(serviceDevices.serviceAccountId, serviceAccountId))
    .orderBy(desc(serviceDevices.installedAt));
}

/**
 * Moves an account onto a new plan from `effectivePeriod` onwards.
 *
 * A change scheduled for a *future* period is recorded as a `PLAN_CHANGED`
 * service event and deliberately leaves `service_accounts.plan_id` and
 * `current_rate_centavos` alone. Billing resolves the rate that was in effect
 * for the period being billed from those events, so a plan upgrade agreed today
 * for next quarter does not silently re-rate the invoices of the months in
 * between (§3.3). When the effective period is the current one or earlier the
 * change is applied straight away.
 */
export async function changeServiceAccountPlan(
  executor: Executor,
  serviceAccountId: string,
  input: { planId: string; effectivePeriod: string; reason: string },
  actor?: Actor
) {
  const [account] = await executor
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);
  if (!account) {
    throw notFound("Service account", serviceAccountId);
  }
  const planRows = await executor
    .select()
    .from(servicePlans)
    .where(eq(servicePlans.id, input.planId))
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    throw notFound("Plan", input.planId);
  }
  if (!plan.isActive) {
    throw businessRule(`Plan ${plan.code} is inactive and cannot be assigned to an account.`);
  }

  const effectiveDate = `${input.effectivePeriod}-01`;
  const isImmediate = input.effectivePeriod <= currentPeriod();

  const [updated] = isImmediate
    ? await executor
        .update(serviceAccounts)
        .set({ planId: plan.id, currentRateCentavos: plan.monthlyPriceCentavos })
        .where(eq(serviceAccounts.id, serviceAccountId))
        .returning()
    : [account];

  await executor.insert(serviceEvents).values({
    serviceAccountId,
    eventType: "PLAN_CHANGED",
    reason: input.reason,
    effectiveDate,
    actorId: actor?.id ?? null,
    actorName: actor?.displayName ?? null,
    notes: isImmediate
      ? "Applied immediately."
      : `Scheduled: takes effect for billing period ${input.effectivePeriod}.`,
    metadata: JSON.stringify({
      planCode: plan.code,
      planId: plan.id,
      previousRateCentavos: account.currentRateCentavos,
      newRateCentavos: plan.monthlyPriceCentavos,
      effectivePeriod: input.effectivePeriod,
      applied: isImmediate
    })
  });

  await writeAudit(executor, actor, {
    action: auditActions.SERVICE_ACCOUNT_PLAN_CHANGED,
    entityType: "service_account",
    entityId: serviceAccountId,
    reason: input.reason,
    changes: isImmediate
      ? {
          planId: { old: account.planId, new: plan.id },
          currentRateCentavos: {
            old: account.currentRateCentavos,
            new: plan.monthlyPriceCentavos
          }
        }
      : { planId: { old: account.planId, new: account.planId } },
    metadata: { effectivePeriod: input.effectivePeriod, applied: isImmediate }
  });
  return updated;
}

/** The `YYYY-MM` period currently being billed, in UTC. */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Billing periods the account is eligible for, i.e. active and started. */
export async function billablePeriods(executor: Executor, serviceAccountId: string) {
  const [account] = await executor
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);
  if (!account) {
    throw notFound("Service account", serviceAccountId);
  }
  return {
    account,
    existingPeriods: new Set(
      (
        await executor
          .select({ period: invoices.period })
          .from(invoices)
          .where(
            and(
              eq(invoices.serviceAccountId, serviceAccountId),
              sql`${invoices.status} <> 'VOID'`
            )
          )
      ).map((row) => row.period)
    ),
    cycles: await executor
      .select()
      .from(billingCycles)
      .orderBy(desc(billingCycles.period))
      .limit(24)
  };
}

export async function assertAreaExists(executor: Executor, areaId: string): Promise<void> {
  const rows = await executor
    .select({ id: collectionAreas.id })
    .from(collectionAreas)
    .where(eq(collectionAreas.id, areaId))
    .limit(1);
  if (!rows[0]) {
    throw new DomainError("VALIDATION_FAILED", "The selected collection area does not exist.", 400);
  }
}

export async function accountCountsByStatus(executor: Executor) {
  return executor
    .select({
      status: serviceAccounts.status,
      total: count()
    })
    .from(serviceAccounts)
    .groupBy(serviceAccounts.status);
}

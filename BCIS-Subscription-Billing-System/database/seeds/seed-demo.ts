/**
 * Demonstration dataset for the BCIS laboratory project (specification §8).
 *
 * The guide is explicit that the demo must not run on a single subscriber, and
 * sets minimum volumes: 5 users, 7 plans (3 Internet / 2 Cable / 2 Combo), 50
 * subscribers, 60+ service accounts, 2 collectors, 3 collection areas, at least
 * three billing months of invoices, a mix of Cash/GCash/partial/exact/advance
 * payments, at least 10 overdue accounts spread across every aging bucket, and
 * at least one reversal plus two suspension/reconnection scenarios.
 *
 * Two properties matter as much as the volumes:
 *
 * 1. **It goes through the real services.** Nothing is inserted with raw SQL to
 *    make a number look right. Every invoice is produced by the billing engine,
 *    every payment is posted and allocated by the payment service, and every
 *    batch is opened, collected, remitted and closed through the collection
 *    services. That is what makes the demo evidence: the ledger balances and the
 *    AR aging reconciles because the same code paths the operator uses produced
 *    it, not because the rows were typed in.
 *
 * 2. **It is idempotent and deterministic.** Re-running never duplicates
 *    anything, and a fixed PRNG seed means the same names, amounts and dates
 *    every time, so a screenshot taken today still matches the report next week.
 *
 * Usage: `npm run seed:demo` (add `--reset` to wipe the transactional tables first)
 */

import { eq, sql } from "drizzle-orm";

import { loadEnvironment } from "../apps/api/src/config/env.js";
import { closeDatabase, getDatabase, inTransaction, type Executor } from "../apps/api/src/db/client.js";
import {
  collectionRoutes,
  collectors,
  invoices,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscribers,
  technicians,
  users
} from "../apps/api/src/db/schema/index.js";
import {
  createUser,
  loadPermissionsForUser,
  seedSecurityCatalog
} from "../apps/api/src/services/auth.js";
import { generateMonthlyBilling, refreshOverdueStatuses } from "../apps/api/src/services/billing.js";
import {
  addBatchAccounts,
  closeBatch,
  confirmRemittance,
  openBatch,
  recordCollection,
  submitRemittance,
  transitionBatch
} from "../apps/api/src/services/collections.js";
import {
  createPlan,
  createServiceAccount,
  createSubscriber,
  upsertCollectionArea,
  upsertCollectionRoute,
  upsertCollector,
  upsertTechnician
} from "../apps/api/src/services/directory.js";
import { postPayment, reversePayment, submitGcashProof, verifyGcashProof } from "../apps/api/src/services/payments.js";
import {
  approveSuspension,
  completeReconnection,
  confirmReconnectionFee,
  createSuspensionRequest,
  executeSuspension,
  requestReconnection
} from "../apps/api/src/services/service-control.js";
import { updateSetting } from "../apps/api/src/services/settings.js";
import type { Actor } from "../apps/api/src/services/types.js";

loadEnvironment();

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * `Math.random()` would make the demo dataset different on every run, which
 * defeats the purpose of a reproducible demonstration: a bug reported against
 * "account SUB-1007" could not be reproduced tomorrow. A fixed seed plus a fixed
 * iteration order gives byte-identical data every time.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260928);

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function chance(probability: number): boolean {
  return random() < probability;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** The billing periods the demo covers, oldest first. */
const BILLING_PERIODS = ["2026-06", "2026-07", "2026-08", "2026-09"] as const;

const PERIOD_INDEX = new Map<string, number>(BILLING_PERIODS.map((period, index) => [period, index]));

/** Index of a billed period, failing loudly rather than silently producing `NaN`. */
function periodIndex(period: string): number {
  const index = PERIOD_INDEX.get(period);
  if (index === undefined) {
    throw new Error(`Seed asked for an unbilled period: ${period}`);
  }
  return index;
}

/** A UTC date `days` in the past, so the result never depends on the runner's timezone. */
function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Pesos to centavos. Every amount in this file is written in pesos for readability. */
function pesos(value: number): number {
  return Math.round(value * 100);
}

const USERS = [
  { username: "owner", displayName: "Rowela P. Dizon", roleCodes: ["OWNER"] },
  { username: "admin", displayName: "Marlon A. Tayko", roleCodes: ["ADMINISTRATOR"] },
  { username: "cashier", displayName: "Juvy R. Lambo", roleCodes: ["CASHIER"] },
  { username: "supervisor", displayName: "Elena B. Razon", roleCodes: ["COLLECTION_SUPERVISOR"] },
  { username: "auditor", displayName: "Gil C. Manlapaz", roleCodes: ["ACCOUNTANT_AUDITOR"] },
  { username: "technician", displayName: "Rico S. Balao", roleCodes: ["TECHNICIAN"] },
  { username: "viewer", displayName: "Liza C. Ferrer", roleCodes: ["READONLY_VIEWER"] }
] as const;

/**
 * The single password for every demo account.
 *
 * These are synthetic laboratory accounts (§8 requires synthetic data and forbids
 * real credentials), and the deployment guide tells the examiner to change them.
 * One uniform, documented password is far better than seven undocumented ones.
 */
const DEMO_PASSWORD = "Bcis@2026";

/** 7 plans: 3 Internet, 2 Cable, 2 Combo (§8). */
const PLANS = [
  { code: "INT-10", name: "Fiber 10 Mbps", serviceType: "INTERNET", monthlyPrice: 999, installationFee: 1000, reconnectionFee: 350, speedMbps: 10, channelCount: null },
  { code: "INT-25", name: "Fiber 25 Mbps", serviceType: "INTERNET", monthlyPrice: 1299, installationFee: 1200, reconnectionFee: 400, speedMbps: 25, channelCount: null },
  { code: "INT-50", name: "Fiber 50 Mbps", serviceType: "INTERNET", monthlyPrice: 1899, installationFee: 1500, reconnectionFee: 450, speedMbps: 50, channelCount: null },
  { code: "CAB-40", name: "Cable 40 Channels", serviceType: "CABLE", monthlyPrice: 599, installationFee: 800, reconnectionFee: 300, speedMbps: null, channelCount: 40 },
  { code: "CAB-80", name: "Cable 80 Channels", serviceType: "CABLE", monthlyPrice: 799, installationFee: 1000, reconnectionFee: 350, speedMbps: null, channelCount: 80 },
  { code: "COMBO-10", name: "Combo Fiber 10 + Cable 40", serviceType: "COMBO", monthlyPrice: 1399, installationFee: 1500, reconnectionFee: 450, speedMbps: 10, channelCount: 40 },
  { code: "COMBO-25", name: "Combo Fiber 25 + Cable 80", serviceType: "COMBO", monthlyPrice: 1799, installationFee: 1800, reconnectionFee: 500, speedMbps: 25, channelCount: 80 }
] as const;

/** 3 collection areas (§8). */
const AREAS = [
  { code: "NORTH", name: "North District", description: "Poblacion, North Hills and Kibrahan" },
  { code: "CENTRAL", name: "Central District", description: "Lilingayon, San Agustin and Magsaysay" },
  { code: "SOUTH", name: "South District", description: "Casisang, Impasug-ong and Sumilao" }
] as const;

const FIRST_NAMES = [
  "Maria", "Jose", "Liza", "Ramon", "Ana", "Carlo", "Grace", "Rodel", "Teresita", "Jun",
  "Marcelo", "Imelda", "Nestor", "Elena", "Ricky", "Lorna", "Dante", "Violeta", "Ernesto", "Perlita",
  "Ariel", "Minda", "Rogelio", "Carmela", "Ferdinand", "Luisa", "Nicanor", "Aida", "Romeo", "Miriam",
  "Crisanto", "Emeralda", "Bonifacio", "Zaldy", "Leonor", "Anselmo", "Divina", "Efren", "Gloria", "Norberto",
  "Pascual", "Rosario", "Teodoro", "Willie", "Yolanda", "Zaldy", "Amparo", "Bernardo", "Celia", "Dante"
] as const;

const LAST_NAMES = [
  "Dela Cruz", "Ramos", "Bautista", "Oclarit", "Villanueva", "Sumulong", "Lopueza", "Cabanglasan",
  "Magsaysay", "Pangantucan", "Reyes", "Salazar", "Tanucan", "Libot", "Pacala", "Quiambao",
  "Roxas", "Salamanca", "Toledo", "Ubaldo", "Valdez", "Wagas", "Yap", "Zamora"
] as const;

const STREETS = [
  "Blk 1 Lot 2", "Zone 3", "Purok 5", "Lot 12 Phase 2", "Blk 7 Lot 3", "Purok 1",
  "Lot 4 Phase 1", "Blk 3 Lot 9", "Zone 6", "Purok 8", "Lot 21 Phase 3", "Blk 5 Lot 1"
] as const;

const BARANGAYS = [
  "Poblacion", "North Hills", "San Agustin", "Lilingayon", "Magsaysay", "Casisang",
  "Kibawe", "Sumilao", "Impasug-ong", "Manolo Fortich"
] as const;

const CITIES = ["Malaybalay City", "Valencia City", "Sumilao", "Impasug-ong", "Pangantucan"] as const;

/** 2 collectors (§8). */
const COLLECTORS = [
  { code: "COL-A", fullName: "Ana L. Reyes", contactNumber: "09171234567" },
  { code: "COL-B", fullName: "Ben P. Santos", contactNumber: "09182345678" }
] as const;

const TECHNICIANS = [
  { code: "TECH-1", fullName: "Rico S. Balao", contactNumber: "09185550101" },
  { code: "TECH-2", fullName: "Nestor P. Uy", contactNumber: "09185550102" }
] as const;

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`  ${message}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const peso = (centavos: number): string =>
  (centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Loads the seeded owner so the rest of the seed runs with real, data-driven permissions. */
async function ownerActor(executor: Executor, ownerId: string): Promise<Actor> {
  const { permissions } = await loadPermissionsForUser(executor, ownerId);
  return { id: ownerId, username: "owner", displayName: "Rowela P. Dizon", permissions };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Roles, permissions and their mapping.
 *
 * Authorization in this system is read from these three tables, not from the
 * TypeScript matrix, so this has to run before any user is created.
 */
async function stepSecurityCatalog(db: Executor): Promise<void> {
  section("Security catalog");
  await seedSecurityCatalog(db);
  const result = await db.execute(
    sql`select (select count(*) from roles)::int as roles, (select count(*) from permissions)::int as permissions, (select count(*) from role_permissions)::int as mappings`
  );
  const row = result.rows[0] as { roles: number; permissions: number; mappings: number };
  log(`${row.roles} roles, ${row.permissions} permissions, ${row.mappings} role-permission mappings`);
}

async function stepUsers(db: Executor): Promise<Record<string, string>> {
  section("Users");
  const ids: Record<string, string> = {};

  for (const spec of USERS) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, spec.username)).limit(1);
    if (existing[0]) {
      ids[spec.username] = existing[0].id;
      log(`${spec.username.padEnd(11)} already present`);
      continue;
    }
    const created = await createUser(
      db,
      {
        username: spec.username,
        displayName: spec.displayName,
        email: `${spec.username}@bcis.demo`,
        password: DEMO_PASSWORD,
        roleCodes: [...spec.roleCodes],
        isActive: true
      },
      undefined
    );
    ids[spec.username] = created.id;
    log(`${spec.username.padEnd(11)} created  (${spec.roleCodes.join(", ")})`);
  }

  return ids;
}

async function stepDirectory(db: Executor, owner: Actor) {
  section("Service types, plans, areas, routes, collectors, technicians");

  for (const type of [
    { code: "INTERNET", name: "Internet", description: "Internet access service" },
    { code: "CABLE", name: "Cable", description: "Cable television service" },
    { code: "COMBO", name: "Combo", description: "Bundle of internet and cable" }
  ] as const) {
    await db
      .insert(serviceTypes)
      .values(type)
      .onConflictDoNothing({ target: serviceTypes.code });
  }
  log("service types: INTERNET, CABLE, COMBO");

  const planIds: string[] = [];
  // `createPlan` is the create-only service the operator uses, and it rightly
  // refuses a duplicate code, so the seed has to check first rather than rely on
  // the service being forgiving. The lookup is case-insensitive to match the
  // database's `service_plans_code_unique` index on `lower(code)`.
  const existingPlans = await db
    .select({ id: servicePlans.id, code: servicePlans.code })
    .from(servicePlans);
  const existingByCode = new Map(existingPlans.map((row) => [row.code.toLowerCase(), row.id]));

  let plansCreated = 0;
  for (const plan of PLANS) {
    const existingId = existingByCode.get(plan.code.toLowerCase());
    if (existingId) {
      planIds.push(existingId);
      continue;
    }
    const created = await createPlan(
      db,
      {
        code: plan.code,
        name: plan.name,
        serviceType: plan.serviceType,
        monthlyPrice: pesos(plan.monthlyPrice),
        installationFee: pesos(plan.installationFee),
        reconnectionFee: pesos(plan.reconnectionFee),
        speedMbps: plan.speedMbps,
        channelCount: plan.channelCount,
        description: `${plan.serviceType} subscription plan`,
        isActive: true
      },
      owner
    );
    planIds.push(created.id);
    plansCreated += 1;
  }
  log(`plans: ${planIds.length} available (3 Internet, 2 Cable, 2 Combo), ${plansCreated} created this run`);

  const areaIds: string[] = [];
  for (const area of AREAS) {
    const row = await upsertCollectionArea(db, { ...area, isActive: true }, owner);
    areaIds.push(row.id);
  }
  log(`collection areas: ${areaIds.length}`);

  const collectorIds: string[] = [];
  for (const collector of COLLECTORS) {
    const row = await upsertCollector(db, { ...collector, isActive: true });
    collectorIds.push(row.id);
  }
  log(`collectors: ${collectorIds.length}`);

  const routeIds: string[] = [];
  for (let index = 0; index < areaIds.length; index += 1) {
    const area = AREAS[index]!;
    const row = await upsertCollectionRoute(db, {
      areaId: areaIds[index]!,
      code: `R-${area.code}`,
      name: `${area.name} Route`,
      description: `House-to-house route for ${area.name}`,
      isActive: true
    });
    routeIds.push(row.id);
  }
  log(`collection routes: ${routeIds.length}`);

  const technicianIds: string[] = [];
  for (const technician of TECHNICIANS) {
    const row = await upsertTechnician(db, { ...technician, isActive: true });
    technicianIds.push(row.id);
  }
  log(`technicians: ${technicianIds.length}`);

  return { planIds, areaIds, collectorIds, routeIds, technicianIds };
}

interface SeededAccounts {
  accountIds: string[];
  accountCollector: Map<string, string | null>;
}

/** §8: 50 subscribers and 60+ service accounts. */
async function stepSubscribersAndAccounts(
  db: Executor,
  owner: Actor,
  directory: { planIds: string[]; areaIds: string[]; collectorIds: string[] }
): Promise<SeededAccounts> {
  section("Subscribers and service accounts");

  const existing = await db.select({ id: serviceAccounts.id, collectorId: serviceAccounts.collectorId }).from(serviceAccounts);
  if (existing.length > 0) {
    log(`already seeded: ${existing.length} service accounts left untouched`);
    return {
      accountIds: existing.map((row) => row.id),
      accountCollector: new Map(existing.map((row) => [row.id, row.collectorId]))
    };
  }

  const accountIds: string[] = [];
  const accountCollector = new Map<string, string | null>();

  for (let index = 0; index < 50; index += 1) {
    const first = FIRST_NAMES[index % FIRST_NAMES.length]!;
    const last = LAST_NAMES[index % LAST_NAMES.length]!;
    const areaIndex = index % directory.areaIds.length;
    const street = STREETS[index % STREETS.length]!;
    const barangay = BARANGAYS[index % BARANGAYS.length]!;
    const city = CITIES[index % CITIES.length]!;

    const subscriber = await createSubscriber(
      db,
      {
        accountNumber: `SUB-${1001 + index}`,
        fullName: `${first} ${last}`,
        contactNumber: `0918${String(1000000 + index * 137).slice(0, 7)}`,
        email: `${first.toLowerCase()}.${index + 1}@bcis.demo`,
        addressLine: `${street}, ${barangay}`,
        city,
        collectionAreaId: directory.areaIds[areaIndex]!,
        notes: null,
        status: "ACTIVE"
      },
      owner
    );

    // Every fifth subscriber gets a second service address, which is what takes
    // the account count past the 60 the specification asks for and demonstrates
    // "one subscriber, many service accounts" at the same time.
    const accountCount = index % 5 === 0 ? 2 : 1;
    for (let n = 0; n < accountCount; n += 1) {
      const planId = directory.planIds[(index + n) % directory.planIds.length]!;
      const collectorId = directory.collectorIds[(index + n) % directory.collectorIds.length]!;
      const account = await createServiceAccount(
        db,
        {
          subscriberId: subscriber.id,
          planId,
          installationAddress: n === 0
            ? `${street}, ${barangay}, ${city}`
            : `${STREETS[(index + 5) % STREETS.length]}, ${barangay}, ${city}`,
          collectorId,
          activationDate: daysAgo(200 - index),
          billingStartPeriod: BILLING_PERIODS[0],
          billingDueDay: 5 + (index % 10),
          status: "ACTIVE",
          notes: null
        },
        owner
      );
      accountIds.push(account.id);
      accountCollector.set(account.id, collectorId);
    }
  }

  log(`subscribers: 50, service accounts: ${accountIds.length}`);
  return { accountIds, accountCollector };
}

async function stepSettings(db: Executor, owner: Actor): Promise<void> {
  section("Application settings");
  const settings: Array<readonly [string, string | number | boolean, string]> = [
    ["billing.grace_period_days", 3, "Days after the due date before an account shows as overdue"],
    ["service.suspension_threshold_months", 2, "Months of arrears before an account is a suspension candidate"],
    ["billing.late_penalty_centavos", 5000, "Penalty added to an overdue invoice when the penalty rule is on"],
    ["billing.penalty_enabled", false, "Whether the billing generator applies late penalties"],
    ["service.default_reconnection_fee_centavos", 20000, "Reconnection fee when a plan does not define one"],
    ["general.company_name", "Bukidnon Cable and Internet Services", "Business name printed on receipts and reports"],
    ["general.company_address", "Poblacion, Malaybalay City, Bukidnon", "Business address printed on receipts and reports"],
    ["general.business_name", "BCIS", "Short business name used in the desktop title bar"],
    ["billing.default_due_day", 5, "Default due day for accounts that do not set their own"]
  ];
  for (const [key, value, description] of settings) {
    await updateSetting(db, key, value, { description, actor: owner });
  }
  log("grace period, suspension threshold, penalty and company details written");
}

/** §8: at least three billing months of invoices. */
async function stepBilling(db: Executor, owner: Actor): Promise<void> {
  section("Monthly billing");
  for (const period of BILLING_PERIODS) {
    const result = await generateMonthlyBilling({ period }, owner);
    log(
      `${period}   created ${String(result.created).padStart(3)}   skipped ${String(result.skipped).padStart(3)}   ` +
        `billed ${peso(result.totalBilledCentavos)}`
    );
  }
  const refreshed = await refreshOverdueStatuses(db);
  log(`overdue statuses refreshed on ${refreshed} invoices`);
}

// ---------------------------------------------------------------------------
// The payment plan
// ---------------------------------------------------------------------------

/**
 * How each service account behaves across the four billed periods.
 *
 * The mix is chosen so the demo has something to show in every screen: a healthy
 * majority, exact and partial payers, advance payers, accounts that have slipped
 * into each aging bucket, and two accounts carried through suspension and
 * reconnection.
 */
type Behaviour =
  | { kind: "pays_in_full" }
  | { kind: "pays_partially" }
  | { kind: "pays_in_advance" }
  | { kind: "gcash_payer" }
  | { kind: "delinquent"; unpaidFrom: number }
  | { kind: "suspended" };

/**
 * 62 accounts. Most pay. The last 18 before the suspended pair are delinquent
 * with a staggered first-unpaid month, which is what spreads arrears across the
 * Current, 1-30, 31-60, 61-90 and 90+ aging buckets and gives the receivables
 * screens more than ten overdue accounts to show.
 */
function behaviourPlan(total: number): Behaviour[] {
  const plan: Behaviour[] = [];
  for (let index = 0; index < total; index += 1) {
    if (index >= total - 2) {
      plan.push({ kind: "suspended" });
    } else if (index >= total - 18) {
      plan.push({ kind: "delinquent", unpaidFrom: (index - (total - 18)) % BILLING_PERIODS.length });
    } else if (index % 11 === 0) {
      plan.push({ kind: "pays_in_advance" });
    } else if (index % 7 === 0) {
      plan.push({ kind: "pays_partially" });
    } else if (index % 3 === 0) {
      plan.push({ kind: "gcash_payer" });
    } else {
      plan.push({ kind: "pays_in_full" });
    }
  }
  return plan;
}

interface InvoiceSummary {
  id: string;
  serviceAccountId: string;
  period: string;
  totalCentavos: number;
}

const NON_CASH_METHODS = ["GCASH", "BANK_TRANSFER", "CHEQUE"] as const;

/** Steps 2 and 3: the payment mix, including the GCash queue and the reversal. */
async function stepPayments(db: Executor, owner: Actor, seeded: SeededAccounts): Promise<void> {
  section("Payments");
  const { accountIds, accountCollector } = seeded;
  const plan = behaviourPlan(accountIds.length);

  const invoiceRows: InvoiceSummary[] = await db
    .select({
      id: invoices.id,
      serviceAccountId: invoices.serviceAccountId,
      period: invoices.period,
      totalCentavos: invoices.totalCentavos
    })
    .from(invoices)
    .orderBy(invoices.period);

  const byAccount = new Map<string, InvoiceSummary[]>();
  for (const row of invoiceRows) {
    const list = byAccount.get(row.serviceAccountId) ?? [];
    list.push(row);
    byAccount.set(row.serviceAccountId, list);
  }

  const existingPayments = await db.execute(sql`select count(*)::int as count from payments`);
  if ((existingPayments.rows[0] as { count: number }).count > 0) {
    log("payments already present; left untouched");
    return;
  }

  let receipts = 0;
  let viaGcash = 0;
  let withAdvance = 0;
  let reversals = 0;

  for (let index = 0; index < accountIds.length; index += 1) {
    const accountId = accountIds[index]!;
    const behaviour = plan[index]!;

    // The suspended pair pays nothing; their arrears drive the suspension
    // workflow in the next step.
    if (behaviour.kind === "suspended") {
      continue;
    }

    const accountInvoices = byAccount.get(accountId) ?? [];
    if (accountInvoices.length === 0) {
      continue;
    }
    const collectorId = accountCollector.get(accountId) ?? null;

    for (const invoice of accountInvoices) {
      if (behaviour.kind === "delinquent" && periodIndex(invoice.period) >= behaviour.unpaidFrom) {
        continue;
      }

      const method =
        behaviour.kind === "gcash_payer" || chance(0.25) ? "GCASH" : pick(NON_CASH_METHODS);

      // A GCash payment has to clear the proof queue before it is posted (§3.7):
      // it enters as a proof and is approved by the reviewer, never straight to
      // `postPayment`.
      if (method === "GCASH") {
        const referenceNumber = `GC${String(800000000 + index * 977 + periodIndex(invoice.period)).slice(0, 9)}`;
        const proof = await inTransaction(async (tx) =>
          submitGcashProof(
            tx,
            {
              serviceAccountId: accountId,
              referenceNumber,
              senderName: "Demo Subscriber",
              amountCentavos: invoice.totalCentavos,
              proofNote: "Synthetic GCash proof for the laboratory demonstration"
            },
            owner
          )
        );
        await inTransaction(async (tx) =>
          verifyGcashProof(
            tx,
            proof.id,
            { approved: true, note: "Verified for the laboratory demonstration" },
            owner
          )
        );
        viaGcash += 1;
        receipts += 1;
        continue;
      }

      // Partial payers settle every invoice but leave the most recent one only
      // partly paid, which is what puts PARTIALLY_PAID on screen.
      const isPartial = behaviour.kind === "pays_partially" && invoice === accountInvoices[accountInvoices.length - 1];
      const amountCentavos = isPartial
        ? Math.max(1, Math.round(invoice.totalCentavos * 0.6))
        : invoice.totalCentavos;

      const result = await inTransaction(async (tx) =>
        postPayment(
          tx,
          {
            serviceAccountId: accountId,
            amountCentavos,
            method,
            paymentDate: new Date(`${invoice.period}-27T09:00:00.000Z`),
            referenceNumber: `RCP-${1000 + index}-${periodIndex(invoice.period)}`,
            notes: null
          },
          owner
        )
      );
      receipts += 1;
      if (result.advanceCentavos > 0) {
        withAdvance += 1;
      }

      // One payment is reversed so the demo carries the §8 "at least one approved
      // example" of the reversal path together with its audit trail. The target
      // is the first payment posted through `postPayment`, chosen by flag rather
      // than by a hard-coded account index: an index can land on a GCash payer,
      // which never reaches this code, and the reversal would silently vanish.
      if (reversals === 0) {
        await inTransaction(async (tx) =>
          reversePayment(
            tx,
            result.paymentId,
            "Synthetic reversal for the laboratory demonstration (specification §8)",
            owner
          )
        );
        reversals += 1;
      }
    }

    // An advance payer hands over three months' worth up front. The surplus is
    // held as credit on account and then absorbed by the next invoice, which is
    // the documented advance policy and the case AT-03 covers.
    if (behaviour.kind === "pays_in_advance") {
      const latest = accountInvoices[accountInvoices.length - 1]!;
      const result = await inTransaction(async (tx) =>
        postPayment(
          tx,
          {
            serviceAccountId: accountId,
            amountCentavos: pesos(3000),
            method: "CASH",
            paymentDate: new Date(`${latest.period}-28T10:30:00.000Z`),
            referenceNumber: `ADV-${1000 + index}`,
            notes: "Advance payment covering the next billing month"
          },
          owner
        )
      );
      receipts += 1;
      if (result.advanceCentavos > 0) {
        withAdvance += 1;
      }
    }
  }

  log(`receipts issued: ${receipts}`);
  log(`posted through the GCash verification queue: ${viaGcash}`);
  log(`payments leaving advance credit on account: ${withAdvance}`);
  log(`reversals: ${reversals}`);
}

/** §8: at least two suspension and reconnection scenarios. */
async function stepServiceControl(db: Executor, owner: Actor, accountIds: string[]): Promise<void> {
  section("Suspension and reconnection");

  const existing = await db.execute(sql`select count(*)::int as count from suspension_records`);
  if ((existing.rows[0] as { count: number }).count > 0) {
    log("suspension history already present; left untouched");
    return;
  }

  const techniciansList = await db.select({ id: technicians.id }).from(technicians);
  const technicianId = techniciansList[0]?.id ?? null;
  const targets = accountIds.slice(-2);

  for (let index = 0; index < targets.length; index += 1) {
    const accountId = targets[index]!;
    const suspension = await inTransaction(async (tx) =>
      createSuspensionRequest(
        tx,
        {
          serviceAccountId: accountId,
          reason: "Arrears beyond the configured suspension threshold",
          effectiveDate: daysAgo(12 - index * 2),
          notes: "Synthetic scenario for the laboratory demonstration"
        },
        owner
      )
    );
    await inTransaction(async (tx) => approveSuspension(tx, suspension.id, owner));
    await inTransaction(async (tx) => executeSuspension(tx, suspension.id, owner));

    const reconnection = await inTransaction(async (tx) =>
      requestReconnection(
        tx,
        {
          serviceAccountId: accountId,
          suspensionId: suspension.id,
          technicianId,
          requestDate: daysAgo(6 - index * 2),
          notes: "Subscriber settled the arrears and requested restoration of service"
        },
        owner
      )
    );

    // The reconnection workflow is gated on the fee invoice actually being paid,
    // so the seed has to pay it before the job can move on. The allocation is
    // explicit: these accounts are the delinquent ones, so a default oldest-first
    // payment would be swallowed by four months of arrears and the fee invoice
    // would still show a balance.
    let paid = false;
    const feeInvoiceId = reconnection.invoiceId;
    if (feeInvoiceId) {
      const fee = await db
        .select({ totalCentavos: invoices.totalCentavos })
        .from(invoices)
        .where(eq(invoices.id, feeInvoiceId))
        .limit(1);
      if (fee[0]) {
        await inTransaction(async (tx) =>
          postPayment(
            tx,
            {
              serviceAccountId: accountId,
              amountCentavos: fee[0].totalCentavos,
              method: index === 0 ? "CASH" : "GCASH",
              paymentDate: new Date(`${daysAgo(4 - index * 2)}T11:00:00.000Z`),
              referenceNumber: `REC-${900 + index}`,
              notes: "Reconnection fee",
              allocations: [{ invoiceId: feeInvoiceId, amountCentavos: fee[0].totalCentavos }]
            },
            owner
          )
        );
        paid = true;
      }
    }

    if (paid && index === 0 && technicianId) {
      await inTransaction(async (tx) => confirmReconnectionFee(tx, reconnection.id, owner));
      await inTransaction(async (tx) => completeReconnection(tx, reconnection.id, { technicianId, completedDate: daysAgo(1) }, owner));
      log(`account ${index + 1}   suspended, reconnection fee paid, technician assigned, service restored`);
    } else {
      log(`account ${index + 1}   suspended, reconnection ${paid ? "fee paid, awaiting the technician" : "awaiting the reconnection fee"}`);
    }
  }
}

/** §3.8: one batch that reconciles cleanly and one that comes up short. */
async function stepCollections(
  db: Executor,
  owner: Actor,
  directory: { areaIds: string[]; collectorIds: string[]; routeIds: string[] }
): Promise<void> {
  section("Collection batches and remittances");

  const existing = await db.execute(sql`select count(*)::int as count from collection_batches`);
  if ((existing.rows[0] as { count: number }).count > 0) {
    log("collection batches already present; left untouched");
    return;
  }

  // The batches have to visit accounts that actually owe something. Picking the
  // first N accounts of a collector looks reasonable but collects zero, because
  // most of them are already settled -- and a batch with nothing due produces a
  // remittance with no discrepancy, which is the opposite of what AT-08 is meant
  // to demonstrate.
  const owing = await db.execute(sql`
    select sa.id, sa.collector_id
    from service_accounts sa
    where exists (
      select 1 from invoices i
      where i.service_account_id = sa.id
        and i.balance_centavos > 0
        and i.status not in ('VOID', 'CREDITED')
    )
    order by sa.service_account_number
  `);

  const rows = owing.rows as Array<{ id: string; collector_id: string | null }>;
  const forCollectorA = rows.filter((row) => row.collector_id === directory.collectorIds[0]).slice(0, 5);
  const forCollectorB = rows.filter((row) => row.collector_id === directory.collectorIds[1]).slice(0, 5);

  if (forCollectorA.length === 0 || forCollectorB.length === 0) {
    log(`only ${rows.length} account(s) owe money; a second collector's batch cannot be built`);
    return;
  }
  log(`${rows.length} accounts have an outstanding balance`);

  await runBatch({
    db,
    owner,
    label: "batch 1  (reconciles cleanly, AT-07)",
    areaId: directory.areaIds[0]!,
    routeId: directory.routeIds[0] ?? null,
    collectorId: directory.collectorIds[0]!,
    accountIds: forCollectorA.map((row) => row.id),
    batchDate: daysAgo(7),
    shortage: 0,
    notes: "Balanced collection for the laboratory demonstration"
  });

  await runBatch({
    db,
    owner,
    label: "batch 2  (remitted short, AT-08)",
    areaId: directory.areaIds[1] ?? directory.areaIds[0]!,
    routeId: directory.routeIds[1] ?? null,
    collectorId: directory.collectorIds[1]!,
    accountIds: forCollectorB.map((row) => row.id),
    batchDate: daysAgo(3),
    shortage: pesos(500),
    notes: "Short remittance for the laboratory demonstration"
  });
}

interface BatchScenario {
  db: Executor;
  owner: Actor;
  label: string;
  areaId: string;
  routeId: string | null;
  collectorId: string;
  accountIds: string[];
  batchDate: string;
  /** Pesos the collector failed to remit. 0 for the balanced batch. */
  shortage: number;
  notes: string;
}

/** Opens a batch, collects every account in cash, remits, reconciles and closes. */
async function runBatch(scenario: BatchScenario): Promise<void> {
  const { db, owner } = scenario;

  const batch = await inTransaction(async (tx) =>
    openBatch(
      tx,
      {
        areaId: scenario.areaId,
        routeId: scenario.routeId,
        collectorId: scenario.collectorId,
        batchDate: scenario.batchDate,
        notes: scenario.notes
      },
      owner
    )
  );
  await inTransaction(async (tx) => addBatchAccounts(tx, batch.id, scenario.accountIds, owner));
  await inTransaction(async (tx) => transitionBatch(tx, batch.id, "IN_PROGRESS", null, owner));

  const due = await db.execute(
    sql`select id as batch_account_id, total_due_centavos from batch_accounts where batch_id = ${batch.id}`
  );

  let collected = 0;
  for (const row of due.rows as Array<{ batch_account_id: string; total_due_centavos: number }>) {
    if (row.total_due_centavos <= 0) {
      continue;
    }
    await inTransaction(async (tx) =>
      recordCollection(
        tx,
        { batchAccountId: row.batch_account_id, amountCentavos: row.total_due_centavos, status: "COLLECTED", method: "CASH", notes: null },
        owner
      )
    );
    collected += row.total_due_centavos;
  }

  await inTransaction(async (tx) => transitionBatch(tx, batch.id, "SUBMITTED", null, owner));
  const remittance = await inTransaction(async (tx) =>
    submitRemittance(
      tx,
      {
        batchId: batch.id,
        cashRemittedCentavos: Math.max(0, collected - scenario.shortage),
        nonCashCollectedCentavos: 0,
        remarks: scenario.shortage > 0 ? `Remitted ${peso(scenario.shortage)} short of the cash collected` : "Cash count matches the batch"
      },
      owner
    )
  );
  const confirmation = await inTransaction(async (tx) =>
    confirmRemittance(tx, remittance.id, true, "Counted and agreed with the collector", owner)
  );

  // A batch that came up short must not close silently: the first attempt is
  // expected to be refused, and only an explicit acknowledgement lets it
  // through. That is the behaviour AT-08 requires, so the seed demonstrates the
  // refusal rather than assuming it. The balanced batch has no discrepancy and
  // closes on the first attempt, so probing it would only produce a CLOSED-state
  // error.
  let refused = false;
  if (scenario.shortage > 0) {
    try {
      await inTransaction(async (tx) => closeBatch(tx, batch.id, {}, owner));
    } catch {
      refused = true;
    }
  }
  const closed = await inTransaction(async (tx) =>
    closeBatch(
      tx,
      batch.id,
      {
        notes: scenario.shortage > 0 ? "Closed with an acknowledged shortage" : "Closed with no discrepancy",
        acknowledgeDiscrepancy: scenario.shortage > 0
      },
      owner
    )
  );

  log(
    `${scenario.label}   collected ${peso(collected)}   shortage ${peso(closed.shortageCentavos)}   ` +
      `close refused without acknowledgement: ${refused ? "yes" : "not applicable"}`  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function stepSummary(db: Executor): Promise<void> {
  section("Dataset summary");
  const result = await db.execute(sql`
    select
      (select count(*) from users)::int                      as users,
      (select count(*) from service_plans)::int              as plans,
      (select count(*) from subscribers)::int                as subscribers,
      (select count(*) from service_accounts)::int           as service_accounts,
      (select count(*) from collection_areas)::int           as collection_areas,
      (select count(*) from collectors)::int                 as collectors,
      (select count(*) from invoices)::int                   as invoices,
      (select count(*) from payments)::int                   as payments,
      (select count(*) from payment_proofs)::int             as gcash_proofs,
      (select count(*) from payment_reversals)::int          as reversals,
      (select count(*) from receipts)::int                   as receipts,
      (select count(*) from collection_batches)::int         as batches,
      (select count(*) from collector_remittances)::int      as remittances,
      (select count(*) from suspension_records)::int         as suspensions,
      (select count(*) from reconnection_records)::int       as reconnections,
      (select count(*) from ledger_entries)::int             as ledger_entries,
      (select count(*) from audit_logs)::int                 as audit_logs
  `);
  const summary = result.rows[0] as Record<string, number>;
  for (const [key, value] of Object.entries(summary)) {
    log(`${key.padEnd(18)} ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Wipes the transactional tables so the demo can be rebuilt from scratch. */
async function reset(): Promise<void> {
  const { db } = getDatabase();
  await db.execute(sql`
    truncate table
      audit_logs, backup_history, attachments, application_settings, document_sequences,
      reconnection_records, suspension_records, collector_remittances, batch_accounts, collection_batches,
      collector_assignments, ledger_entries, receipts, payment_reversals, payment_allocations,
      payment_proofs, payments, invoice_adjustments, invoice_items, invoices, billing_cycles,
      service_events, service_devices, service_accounts, subscriber_addresses, subscribers,
      service_plans, technicians, collectors, collection_routes, collection_areas, service_types,
      sessions, user_roles, users
    restart identity cascade
  `);
  console.log("Existing transactional data removed.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--reset")) {
    await reset();
  }

  const { db } = getDatabase();
  console.log("BCIS demonstration dataset (specification §8)");
  console.log("All data is synthetic. No real subscriber, phone number or payment is used.");

  await stepSecurityCatalog(db);
  const userIds = await stepUsers(db);
  const owner = await ownerActor(db, userIds.owner!);

  const directory = await stepDirectory(db, owner);
  const seeded = await stepSubscribersAndAccounts(db, owner, directory);
  await stepSettings(db, owner);
  await stepBilling(db, owner);
  await stepPayments(db, owner, seeded);
  await stepServiceControl(db, owner, seeded.accountIds);
  await stepCollections(db, owner, directory);
  await stepSummary(db);

  console.log(`\nSign in with any of these accounts. Password: ${DEMO_PASSWORD}`);
  for (const spec of USERS) {
    console.log(`  ${spec.username.padEnd(11)} ${spec.roleCodes.join(", ")}`);
  }
}

main()
  .then(async () => {
    await closeDatabase();
  })
  .catch(async (error: unknown) => {
    console.error("\nDemo seed failed:", error instanceof Error ? error.message : error);
    // Drizzle wraps the driver error, so the useful message (missing table,
    // constraint name, SQLSTATE) is one level down on `cause`.
    const chain: unknown[] = [error];
    for (let depth = 0; depth < 4; depth += 1) {
      const current = chain[chain.length - 1];
      if (!current || typeof current !== "object" || !("cause" in current)) {
        break;
      }
      chain.push((current as { cause: unknown }).cause);
    }
    for (const link of chain.slice(1)) {
      if (link && typeof link === "object") {
        const inner = link as { message?: string; detail?: string; hint?: string; code?: string; table?: string };
        if (inner.message) {
          console.error("  cause:", inner.message);
        }
        if (inner.detail) {
          console.error("  detail:", inner.detail);
        }
        if (inner.hint) {
          console.error("  hint:", inner.hint);
        }
        if (inner.code) {
          console.error("  SQLSTATE:", inner.code);
        }
        if (inner.table) {
          console.error("  table:", inner.table);
        }
      }
    }
    await closeDatabase();
    process.exit(1);
  });

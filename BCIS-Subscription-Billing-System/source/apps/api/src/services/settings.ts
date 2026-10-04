import { eq, inArray, sql } from "drizzle-orm";

import { applicationSettings } from "../db/schema/index.js";
import type { Executor } from "../db/client.js";
import { auditActions, writeAudit } from "./audit.js";
import type { Actor } from "./types.js";

/**
 * Runtime-configurable business settings (§3.10, §4.5).
 *
 * These live in `application_settings` rather than in code so that the owner can
 * change the grace period and suspension threshold from the Administration
 * screen without a redeploy. Every read goes through `getSettings`, which returns
 * fully-populated values with documented defaults, so a missing row can never
 * make a financial calculation silently return `undefined`.
 */

export interface AppSettings {
  /** Days after the due date before an account is considered overdue for display. */
  gracePeriodDays: number;
  /** Months of arrears before an account becomes a suspension candidate. */
  suspensionThresholdMonths: number;
  /** Pesos added to an overdue invoice when the penalty rule is enabled. */
  latePenaltyCentavos: number;
  /** Whether the billing generator applies late penalties at all. */
  penaltyEnabled: boolean;
  /** Reconnection fee charged when an account is restored. */
  defaultReconnectionFeeCentavos: number;
  companyName: string;
  companyAddress: string;
  businessName: string;
  /** "YYYY-MM" of the period treated as the current billing month by default. */
  defaultDueDay: number;
}

export const defaultSettings: AppSettings = {
  gracePeriodDays: 3,
  suspensionThresholdMonths: 2,
  latePenaltyCentavos: 5000,
  penaltyEnabled: false,
  defaultReconnectionFeeCentavos: 20000,
  companyName: "Bukidnon Cable and Internet Services",
  companyAddress: "Bukidnon, Philippines",
  businessName: "BCIS",
  defaultDueDay: 5
};

export const settingKeys = {
  gracePeriodDays: "billing.grace_period_days",
  suspensionThresholdMonths: "service.suspension_threshold_months",
  latePenaltyCentavos: "billing.late_penalty_centavos",
  penaltyEnabled: "billing.penalty_enabled",
  defaultReconnectionFeeCentavos: "service.default_reconnection_fee_centavos",
  companyName: "general.company_name",
  companyAddress: "general.company_address",
  businessName: "general.business_name",
  defaultDueDay: "billing.default_due_day"
} as const;

type SettingKey = keyof typeof settingKeys;

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * Loads every known setting, falling back to the documented default for any row
 * that is absent or holds an unparsable value.
 */
export async function getSettings(executor: Executor): Promise<AppSettings> {
  const rows = await executor
    .select()
    .from(applicationSettings)
    .where(inArray(applicationSettings.key, Object.values(settingKeys)));

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const value = <K extends SettingKey>(key: K) => byKey.get(settingKeys[key]);

  return {
    gracePeriodDays: readNumber(value("gracePeriodDays"), defaultSettings.gracePeriodDays),
    suspensionThresholdMonths: readNumber(
      value("suspensionThresholdMonths"),
      defaultSettings.suspensionThresholdMonths
    ),
    latePenaltyCentavos: readNumber(
      value("latePenaltyCentavos"),
      defaultSettings.latePenaltyCentavos
    ),
    penaltyEnabled: readBoolean(value("penaltyEnabled"), defaultSettings.penaltyEnabled),
    defaultReconnectionFeeCentavos: readNumber(
      value("defaultReconnectionFeeCentavos"),
      defaultSettings.defaultReconnectionFeeCentavos
    ),
    companyName: readString(value("companyName"), defaultSettings.companyName),
    companyAddress: readString(value("companyAddress"), defaultSettings.companyAddress),
    businessName: readString(value("businessName"), defaultSettings.businessName),
    defaultDueDay: readNumber(value("defaultDueDay"), defaultSettings.defaultDueDay)
  };
}

/**
 * Writes a setting and audits the change.
 *
 * The previous value is read first so the audit row can carry an `old` value;
 * without it, "who changed the suspension threshold from two months to one, and
 * when" would not be answerable after the fact, which is exactly the kind of
 * question §4.5 expects to be answerable.
 */
export async function updateSetting(
  executor: Executor,
  key: string,
  newValue: unknown,
  options: { description?: string; actor?: Actor } = {}
): Promise<Awaited<ReturnType<typeof settingRow>>> {
  const before = await settingRow(executor, key);
  const label =
    typeof newValue === "string" ? newValue : newValue === null || newValue === undefined ? "—" : String(newValue);

  const [row] = await executor
    .insert(applicationSettings)
    .values({
      key,
      value: newValue as never,
      valueLabel: label,
      description: options.description ?? before?.description ?? "",
      updatedBy: options.actor?.id ?? null,
      updatedByName: options.actor?.displayName ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: applicationSettings.key,
      set: {
        value: newValue as never,
        valueLabel: label,
        description: options.description ?? undefined,
        updatedBy: options.actor?.id ?? null,
        updatedByName: options.actor?.displayName ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  await writeAudit(executor, options.actor, {
    action: auditActions.SETTING_UPDATED,
    entityType: "setting",
    entityId: key,
    changes: {
      value: { old: before?.value ?? null, new: row.value }
    },
    metadata: { valueLabel: label }
  });

  return row;
}

export async function listSettings(executor: Executor) {
  return executor
    .select()
    .from(applicationSettings)
    .orderBy(sql`${applicationSettings.category}, ${applicationSettings.key}`);
}

export async function settingRow(executor: Executor, key: string) {
  const rows = await executor.select().from(applicationSettings).where(eq(applicationSettings.key, key)).limit(1);
  return rows[0] ?? null;
}

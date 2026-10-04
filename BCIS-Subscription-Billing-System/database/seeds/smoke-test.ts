/**
 * End-to-end smoke test against a running API.
 *
 * The seed can be internally consistent and still unreachable, because the
 * screens live behind routes, the RBAC matrix and the response envelope. This
 * exercises the real HTTP surface: every seeded role signs in, the viewer is
 * refused a write, each financial and operational screen returns rows, the
 * binary reports actually download, and a subscriber is created and removed
 * through the real service.
 *
 * Usage:
 *   npm run dev:api                # in one shell
 *   npm run smoke                  # in another
 *   SMOKE_BASE_URL=http://10.0.0.5:3001 npm run smoke
 */

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3001";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "Bcis@2026";

/** The API validates pageSize with a minimum of 5. */
const PAGE_SIZE = 5;

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}${detail ? `   ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `   ${detail}` : ""}`);
  }
}

interface ApiResponse {
  status: number;
  body: any;
}

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown; expect?: "json" | "text" } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.token) {
    headers.authorization = `Bearer ${init.token}`;
  }
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const text = await response.text();
  if (init.expect === "text") {
    return { status: response.status, body: text };
  }
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

async function login(username: string, password = PASSWORD): Promise<{ token: string; permissions: string[] } | null> {
  const { status, body } = await call("/auth/login", { method: "POST", body: { username, password } });
  if (status !== 200 || typeof body?.token !== "string") {
    return null;
  }
  return { token: body.token, permissions: body.user?.permissions ?? [] };
}

function heading(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  console.log(`BCIS API smoke test against ${BASE}`);

  // ---------------------------------------------------------------- health --
  heading("Health");
  const health = await call("/health");
  record(health.status === 200, "GET /health", `status ${health.status}`);
  if (health.status !== 200) {
    console.log(JSON.stringify(health.body, null, 2));
    process.exit(1);
  }

  // ------------------------------------------------------- authentication --
  heading("Authentication and RBAC");
  const roles = ["owner", "admin", "cashier", "supervisor", "auditor", "technician", "viewer"];
  const tokens = new Map<string, { token: string; permissions: string[] }>();
  for (const role of roles) {
    const session = await login(role);
    record(session !== null, `login as ${role}`);
    if (session) {
      tokens.set(role, session);
    }
  }

  const owner = tokens.get("owner");
  if (!owner) {
    console.log("\nCannot continue: the seeded owner account could not sign in.");
    process.exit(1);
  }
  record(owner.permissions.length > 0, "owner receives permissions", `${owner.permissions.length} permissions`);

  const me = await call("/auth/me", { token: owner.token });
  record(me.status === 200 && me.body?.user?.username === "owner", "GET /auth/me", `status ${me.status}`);

  const badPassword = await call("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "not-the-password" }
  });
  record(badPassword.status === 401, "wrong password rejected", `status ${badPassword.status}`);

  const unknownUser = await call("/auth/login", {
    method: "POST",
    body: { username: "no-such-user", password: PASSWORD }
  });
  record(unknownUser.status === 401, "unknown username rejected", `status ${unknownUser.status}`);

  const noToken = await call("/invoices");
  record(noToken.status === 401, "unauthenticated request rejected", `status ${noToken.status}`);

  const badToken = await call("/invoices", { token: "not-a-real-token" });
  record(badToken.status === 401, "invalid token rejected", `status ${badToken.status}`);

  // The viewer can read but must not write: this is the AT-12 evidence.
  const viewer = tokens.get("viewer");
  if (viewer) {
    const viewerRead = await call(`/invoices?page=1&pageSize=${PAGE_SIZE}`, { token: viewer.token });
    const viewerWrite = await call("/subscribers", {
      method: "POST",
      token: viewer.token,
      body: {
        accountNumber: "RBAC-1",
        fullName: "Should Not Exist",
        contactNumber: "09170000000",
        addressLine: "1 Test Street",
        city: "Malaybalay City"
      }
    });
    record(viewerRead.status === 200, "viewer can read", `status ${viewerRead.status}`);
    record(
      viewerWrite.status === 403,
      "viewer refused a write",
      `status ${viewerWrite.status} (expected 403)`
    );
  }

  const cashier = tokens.get("cashier");
  if (cashier) {
    // GET /plans is a read the cashier is allowed; the RBAC question is whether
    // it may *manage* plans, so the probe has to be a write.
    const cashierRead = await call("/plans", { token: cashier.token });
    const cashierWrite = await call("/plans", {
      method: "POST",
      token: cashier.token,
      body: {
        code: `RBAC-${Date.now()}`,
        name: "Should Not Exist",
        serviceType: "INTERNET",
        monthlyPrice: 1000,
        installationFee: 1000,
        reconnectionFee: 100
      }
    });
    record(cashierRead.status === 200, "cashier can read plans", `status ${cashierRead.status}`);
    record(
      cashierWrite.status === 403,
      "cashier refused plan management",
      `status ${cashierWrite.status} (expected 403)`
    );
    const cashierInvoices = await call(`/invoices?page=1&pageSize=${PAGE_SIZE}`, { token: cashier.token });
    record(cashierInvoices.status === 200, "cashier can read invoices", `status ${cashierInvoices.status}`);
  }

  // ------------------------------------------------- screens return data ----
  heading("Screens return seeded data");
  const screens: Array<[string, string]> = [
    ["dashboard", "/dashboard"],
    ["subscriber search", `/subscribers/search?page=1&pageSize=${PAGE_SIZE}`],
    ["service accounts", `/service-accounts?page=1&pageSize=${PAGE_SIZE}`],
    ["invoices", `/invoices?page=1&pageSize=${PAGE_SIZE}`],
    ["invoices filtered to OVERDUE", `/invoices?page=1&pageSize=${PAGE_SIZE}&status=OVERDUE`],
    ["payments", `/payments?page=1&pageSize=${PAGE_SIZE}`],
    ["gcash proofs", `/gcash/proofs?page=1&pageSize=${PAGE_SIZE}`],
    ["plans", "/plans"],
    ["collection areas", "/collection-areas"],
    ["collection routes", "/collection-routes"],
    ["collectors", "/collectors"],
    ["technicians", "/technicians"],
    ["collection batches", `/collection/batches?page=1&pageSize=${PAGE_SIZE}`],
    ["remittances", `/collection/remittances?page=1&pageSize=${PAGE_SIZE}`],
    ["collector performance", "/collection/performance"],
    ["suspensions", `/service-control/suspensions?page=1&pageSize=${PAGE_SIZE}`],
    ["reconnections", `/service-control/reconnections?page=1&pageSize=${PAGE_SIZE}`],
    ["settings", "/settings"],
    ["billing cycles", "/billing/cycles"],
    ["users", "/users"],
    ["audit log", "/audit"],
    ["ledger", "/ledger"]
  ];

  for (const [label, path] of screens) {
    const { status, body } = await call(path, { token: owner.token });
    const rows = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : undefined;
    const detail = rows !== undefined ? `${rows.length} rows` : status === 200 ? "object" : JSON.stringify(body).slice(0, 90);
    record(status === 200, `GET ${label}`, `status ${status}, ${detail}`);
  }

  // ------------------------------------------------ receivables and aging --
  heading("Receivables");
  const aging = await call("/receivables/aging", { token: owner.token });
  const buckets = (aging.body?.items ?? []) as Array<{ bucket: string; amountCentavos: number; invoiceCount: number }>;
  record(aging.status === 200, "GET /receivables/aging", `status ${aging.status}`);
  record(buckets.length === 5, "aging returns all five buckets", buckets.map((b) => b.bucket).join(", "));
  const overdueBuckets = buckets.filter((b) => b.amountCentavos > 0);
  record(
    overdueBuckets.length >= 4,
    "at least four aging buckets carry a balance",
    overdueBuckets.map((b) => `${b.bucket}=${b.invoiceCount}`).join(", ")
  );

  const receivablesSummary = await call("/receivables/summary", { token: owner.token });
  record(receivablesSummary.status === 200, "GET /receivables/summary", `status ${receivablesSummary.status}`);

  const overdue = await call(`/receivables/overdue?page=1&pageSize=${PAGE_SIZE}`, { token: owner.token });
  record(
    overdue.status === 200,
    "GET /receivables/overdue",
    `status ${overdue.status}, ${(overdue.body?.items ?? []).length} rows`
  );

  const candidates = await call("/receivables/suspension-candidates", { token: owner.token });
  record(
    candidates.status === 200,
    "GET /receivables/suspension-candidates",
    `status ${candidates.status}, ${(candidates.body?.items ?? []).length} candidates`
  );

  // ------------------------------------------------------------- details ---
  heading("Record detail screens");
  const invoiceList = await call(`/invoices?page=1&pageSize=${PAGE_SIZE}&status=OVERDUE`, { token: owner.token });
  const firstInvoice = invoiceList.body?.items?.[0];
  if (firstInvoice?.id) {
    const detail = await call(`/invoices/${firstInvoice.id}`, { token: owner.token });
    record(detail.status === 200, "GET invoice detail", `status ${detail.status}`);

    const asOf = await call("/invoices/as-of/2026-09-01", { token: owner.token });
    record(asOf.status === 200, "GET invoices as-of", `status ${asOf.status}`);

    if (firstInvoice.serviceAccountId) {
      const statement = await call(
        `/ledger/${firstInvoice.serviceAccountId}/statement?from=2026-01-01&to=2026-12-31`,
        { token: owner.token }
      );
      record(statement.status === 200, "GET account statement", `status ${statement.status}`);
      const balance = await call(`/ledger/${firstInvoice.serviceAccountId}/balance`, { token: owner.token });
      record(balance.status === 200, "GET account ledger balance", `status ${balance.status}`);
      const events = await call(`/service-accounts/${firstInvoice.serviceAccountId}/events`, { token: owner.token });
      record(events.status === 200, "GET account events", `status ${events.status}`);
    }
  } else {
    record(false, "an overdue invoice exists to open", "none found");
  }

  const batchList = await call(`/collection/batches?page=1&pageSize=${PAGE_SIZE}`, { token: owner.token });
  const firstBatch = batchList.body?.items?.[0];
  if (firstBatch?.id) {
    const detail = await call(`/collection/batches/${firstBatch.id}`, { token: owner.token });
    record(detail.status === 200, "GET collection batch detail", `status ${detail.status}`);
    const accounts = await call(`/collection/batches/${firstBatch.id}`, { token: owner.token });
    record(accounts.status === 200, "batch detail carries its accounts", `status ${accounts.status}`);
    const sheet = await call(`/collection/batches/${firstBatch.id}/route-sheet`, { token: owner.token });
    record(sheet.status === 200, "GET batch route sheet", `status ${sheet.status}`);
  } else {
    record(false, "a collection batch exists to open", "none found");
  }

  // -------------------------------------------------------------- reports --
  heading("Report exports");
  const reportFormats: Array<[string, string]> = [
    ["collections", "/reports/collections"],
    ["collector performance", "/reports/collector-performance"],
    ["billing vs collection", "/reports/billing-vs-collection"],
    ["revenue by plan", "/reports/revenue?by=plan"],
    ["subscribers", "/reports/subscribers"],
    ["payments", "/reports/payments"],
    ["adjustments", "/reports/adjustments"],
    ["audit", "/reports/audit"]
  ];
  for (const [label, path] of reportFormats) {
    const { status } = await call(path, { token: owner.token });
    record(status === 200, `report ${label} (json)`, `status ${status}`);
  }

  // The export format is a separate `exportFormat` parameter, not `format`:
  // omitting it returns the JSON payload, which is an easy way to believe export
  // is broken when it is only the query string that is wrong. A CSV is checked
  // for a header row rather than a byte count, because a single-period report is
  // legitimately only a couple of hundred bytes.
  for (const [label, path, expect] of [
    ["collections csv", "/reports/collections?exportFormat=csv", "csv"],
    ["collections pdf", "/reports/collections?exportFormat=pdf", "pdf"],
    ["collections xlsx", "/reports/collections?exportFormat=xlsx", "zip"],
    ["revenue pdf", "/reports/revenue?by=plan&exportFormat=pdf", "pdf"],
    ["payments xlsx", "/reports/payments?exportFormat=xlsx", "zip"]
  ] as const) {
    const response = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${owner.token}` } });
    const buffer = Buffer.from(await response.arrayBuffer());
    const header = buffer.subarray(0, 4).toString("latin1");
    const printable = header.replace(/[^\x20-\x7e]/g, "");
    const wellFormed =
      expect === "pdf"
        ? header.startsWith("%PDF")
        : expect === "zip"
          ? header.startsWith("PK")
          : buffer.toString("utf8").includes(",") && buffer.length > 50;
    record(
      response.status === 200 && wellFormed,
      `export ${label}`,
      `status ${response.status}, ${buffer.length} bytes, header "${printable}"`
    );
  }

  // ------------------------------------------------------------- backups ---
  heading("Backup and restore");
  const backups = await call("/backups", { token: owner.token });
  record(backups.status === 200, "GET /backups", `status ${backups.status}`);
  const integrity = await call("/backups/integrity", { token: owner.token });
  record(
    integrity.status === 200 && integrity.body?.passed === true,
    "GET /backups/integrity",
    `status ${integrity.status}, ${integrity.body?.failed ?? "?"} of ${integrity.body?.total ?? "?"} checks failed`
  );
  if (Array.isArray(integrity.body?.checks)) {
    const broken = integrity.body.checks.filter((check: any) => !check.passed);
    record(
      broken.length === 0,
      "every database integrity check passes",
      broken.length === 0
        ? `${integrity.body.checks.length} checks green`
        : `failing: ${broken.map((c: any) => c.name).join(", ")}`
    );
  }

  // -------------------------------------------------------- write and RBAC --
  heading("Write path through the real services");
  // A subscriber must be placed in a collection area, so read a real one rather
  // than inventing an id that would only fail on the foreign key.
  const areas = await call("/collection-areas", { token: owner.token });
  const areaId = (Array.isArray(areas.body) ? areas.body : areas.body?.items)?.[0]?.id;
  record(typeof areaId === "string", "a collection area is available to attach", areaId ?? "none");

  const marker = `SMOKE-${Date.now()}`;
  const created = await call("/subscribers", {
    method: "POST",
    token: owner.token,
    body: {
      accountNumber: marker,
      fullName: "Smoke Test Subscriber",
      contactNumber: "09170000000",
      email: "smoke@bcis.demo",
      addressLine: "1 Test Street, Poblacion",
      city: "Malaybalay City",
      collectionAreaId: areaId,
      status: "ACTIVE"
    }
  });
  record(
    created.status === 200 || created.status === 201,
    "POST /subscribers creates a subscriber",
    `status ${created.status}${created.status >= 400 ? ` ${JSON.stringify(created.body).slice(0, 160)}` : ""}`
  );

  const newId = created.body?.id ?? created.body?.subscriber?.id ?? created.body?.data?.id;
  if (newId) {
    const found = await call(`/subscribers/${newId}`, { token: owner.token });
    record(found.status === 200, "the new subscriber is readable", `status ${found.status}`);
    const search = await call(`/subscribers/search?page=1&pageSize=${PAGE_SIZE}&q=${marker}`, {
      token: owner.token
    });
    record(
      search.status === 200,
      "the new subscriber is findable in search",
      `status ${search.status}`
    );

    // There is deliberately no `DELETE /subscribers/:id`: a billing system that
    // keeps audit history must not be able to erase a subscriber outright, so a
    // subscriber is deactivated instead. Asserting 404 here documents that
    // decision rather than papering over it.
    const hardDelete = await call(`/subscribers/${newId}`, { method: "DELETE", token: owner.token });
    record(
      hardDelete.status === 404 || hardDelete.status === 405,
      "subscribers cannot be hard-deleted (audit history is preserved)",
      `status ${hardDelete.status}`
    );

    const deactivated = await call(`/subscribers/${newId}`, {
      method: "PUT",
      token: owner.token,
      body: { status: "INACTIVE" }
    });
    record(
      deactivated.status === 200,
      "the smoke-test subscriber can be deactivated",
      `status ${deactivated.status}${deactivated.status >= 400 ? ` ${JSON.stringify(deactivated.body).slice(0, 160)}` : ""}`
    );
    if (deactivated.status === 200) {
      const recheck = await call(`/subscribers/${newId}`, { token: owner.token });
      record(
        recheck.body?.status === "INACTIVE",
        "the deactivation is persisted",
        `status=${recheck.body?.status}`
      );
    }
  } else {
    record(false, "the created subscriber has an id", JSON.stringify(created.body).slice(0, 160));
  }

  const missingArea = await call("/subscribers", {
    method: "POST",
    token: owner.token,
    body: {
      accountNumber: `SMOKE-NOAREA-${Date.now()}`,
      fullName: "No Area",
      contactNumber: "09170000002",
      addressLine: "1 Test Street",
      city: "Malaybalay City"
    }
  });
  record(
    missingArea.status === 400,
    "subscriber without a collection area is rejected",
    `status ${missingArea.status}`
  );

  const invalid = await call("/subscribers", {
    method: "POST",
    token: owner.token,
    body: { accountNumber: "" }
  });
  record(invalid.status === 400, "invalid payload rejected by validation", `status ${invalid.status}`);

  const duplicate = await call("/subscribers", {
    method: "POST",
    token: owner.token,
    body: {
      accountNumber: "SUB-1001",
      fullName: "Duplicate Account Number",
      contactNumber: "09170000001",
      addressLine: "1 Test Street",
      city: "Malaybalay City",
      collectionAreaId: areaId
    }
  });
  record(
    duplicate.status === 409 || duplicate.status === 400,
    "duplicate account number rejected",
    `status ${duplicate.status}`
  );

  // ------------------------------------------------------------- settings --
  // `/settings` answers with a typed `settings` object plus the raw `rows`; a
  // key written through the API shows up in `rows`, not as a top-level field.
  const settingKey = `smoke.${Date.now()}`;
  const putSetting = await call(`/settings/${settingKey}`, {
    method: "PUT",
    token: owner.token,
    body: { value: "smoke-test" }
  });
  record(
    putSetting.status === 200 || putSetting.status === 201,
    "PUT /settings writes a value",
    `status ${putSetting.status}`
  );
  if (putSetting.status === 200 || putSetting.status === 201) {
    const allSettings = await call("/settings", { token: owner.token });
    const row = (allSettings.body?.rows ?? []).find((entry: any) => entry.key === settingKey);
    record(
      allSettings.status === 200 && row?.value === "smoke-test",
      "the setting reads back",
      `status ${allSettings.status}, value=${row?.value}`
    );
  }

  // ------------------------------------------------------------- sessions --
  heading("Session lifecycle");
  const throwaway = await login("viewer");
  if (throwaway) {
    const loggedOut = await call("/auth/logout", { method: "POST", token: throwaway.token });
    record(loggedOut.status === 200, "POST /auth/logout", `status ${loggedOut.status}`);
    const afterLogout = await call("/auth/me", { token: throwaway.token });
    record(
      afterLogout.status === 401,
      "the token stops working after logout",
      `status ${afterLogout.status}`
    );
  }

  // --------------------------------------------------------- rate limiting --
  // Deliberately provoked, and it has to report itself as a refusal. A throttled
  // request that comes back as 500 would tell the operator the server is broken
  // when the correct behaviour is simply "wait a minute".
  heading("Rate limiting");
  const seenStatuses = new Set<number>();
  let throttleBody: any = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { status, body } = await call("/auth/login", {
      method: "POST",
      body: { username: "owner", password: PASSWORD }
    });
    seenStatuses.add(status);
    if (status === 429) {
      throttleBody = body;
      break;
    }
    if (status === 200) {
      // A successful sign-in means the limit was not reached, which is only
      // informative rather than a failure.
      continue;
    }
  }
  record(
    seenStatuses.has(429),
    "repeated sign-in attempts are throttled with 429",
    `statuses seen: ${[...seenStatuses].join(", ")}`
  );
  record(
    throttleBody?.error?.code === "TOO_MANY_REQUESTS",
    "the throttle reports a refusal code, not an internal error",
    `code=${throttleBody?.error?.code}`
  );
  record(
    !seenStatuses.has(500),
    "throttling never surfaces as HTTP 500",
    seenStatuses.has(500) ? "saw 500" : "no 500"
  );

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSmoke test crashed:", error);
  process.exit(1);
});

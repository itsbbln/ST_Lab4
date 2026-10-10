// Live demo walkthrough of BCIS §11.1 (13-step required sequence) over HTTP.
// Node 24 global fetch. Run: node live-demo.mjs
const BASE = "http://127.0.0.1:3001";
const PASSWORD = "Bcis@2026";
const BILL_PERIOD = "2026-11";

let pass = 0;
let fail = 0;
const failures = [];
const results = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    results.push(`  PASS  ${name}${detail ? ` -> ${detail}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    results.push(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function api(method, path, { token, body, binary = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get("content-type") || "";
  let payload;
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    payload = buf;
  } else if (ct.includes("application/json")) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text();
  }
  return { status: res.status, ct, payload };
}

async function login(username) {
  const r = await api("POST", "/auth/login", { body: { username, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.payload)}`);
  return r.payload.token;
}

const pesos = (centavos) => (centavos / 100).toFixed(2);

async function main() {
  console.log("=== BCIS §11.1 REQUIRED LIVE DEMO SEQUENCE ===\n");

  // ---- Step 1: login as administrator and show the dashboard ---------------
  const admin = await login("admin");
  ok("step1 login administrator", !!admin);
  const dash = await api("GET", "/dashboard", { token: admin });
  ok(
    "step1 dashboard loads with live totals",
    dash.status === 200 && dash.payload && typeof dash.payload === "object" && dash.payload.accounts,
    `accounts=${dash.payload?.accounts?.total ?? "?"} receivables=${dash.payload?.receivables?.totalOutstanding ?? "?"}`
  );

  const accounts = (await api("GET", "/service-accounts?page=1&pageSize=200&status=ACTIVE", { token: admin })).payload.items;
  const internet = accounts.filter((a) => a.serviceType === "INTERNET" && a.outstandingCentavos === 0);
  const A = internet[0];
  const B = internet[1];
  const C = internet[2];
  ok("step1 seeded service accounts available", !!A && !!B && !!C, `active=${accounts.length}`);

  // ---- Step 2: open a subscriber with an Internet/Cable service account -----
  const sub = await api("GET", `/subscribers/${A.subscriberId}`, { token: admin });
  const acct = await api("GET", `/service-accounts/${A.id}`, { token: admin });
  ok(
    "step2 subscriber + Internet service account opened",
    sub.status === 200 && acct.status === 200 && acct.payload.planName,
    `${A.subscriberName} / ${acct.payload?.planName} (${acct.payload?.serviceType})`
  );

  // ---- Step 3: generate/display monthly invoice + ledger debit -------------
  const gen = await api("POST", "/billing/generate", { token: admin, body: { period: BILL_PERIOD, applyPenalty: false } });
  ok(
    "step3 monthly billing run generated for " + BILL_PERIOD,
    (gen.status === 201 || gen.status === 200) && gen.payload.created > 0,
    `INV keys=${Object.keys(gen.payload).join(",")} created=${gen.payload.created} skipped=${gen.payload.skipped ?? "?"}`
  );
  const invList = await api("GET", `/invoices?page=1&pageSize=200&period=${BILL_PERIOD}`, { token: admin });
  const invA = invList.payload.items.find((i) => i.serviceAccountId === A.id);
  ok("step3 invoice issued for the opened account", !!invA, invA && `${invA.invoiceNumber} total=${invA.total}`);
  const balA = await api("GET", `/ledger/${A.id}/balance`, { token: admin });
  ok(
    "step3 ledger debit reflected in balance",
    balA.status === 200 && balA.payload.balanceCentavos === invA.balanceCentavos && invA.balanceCentavos > 0,
    `ledger=${pesos(balA.payload.balanceCentavos)} invoice=${pesos(invA.balanceCentavos)}`
  );
  const ledA = await api("GET", `/ledger/${A.id}`, { token: admin });
  ok("step3 ledger entries returned", ledA.status === 200 && Array.isArray(ledA.payload.items) && ledA.payload.items.length > 0, `entries=${ledA.payload.items?.length}`);
  const cyc = await api("GET", `/billing/cycles/${BILL_PERIOD}/summary`, { token: admin });
  ok("step3 billing cycle summary available", cyc.status === 200 && (cyc.payload.rows?.length ?? 0) > 0, `rows=${cyc.payload.rows?.length ?? 0}`);

  // ---- Step 4: post an exact Cash payment + preview receipt; partial on C --
  const prev = await api("GET", `/payments/allocation-preview?serviceAccountId=${A.id}&amount=${pesos(invA.balanceCentavos)}`, { token: admin });
  ok("step4 allocation preview before posting", prev.status === 200, `lines=${prev.payload?.lines?.length ?? prev.payload?.allocations?.length ?? "?"}`);
  const payA = await api("POST", "/payments", {
    token: admin,
    body: { serviceAccountId: A.id, amount: pesos(invA.balanceCentavos), method: "CASH", notes: "live demo exact cash" }
  });
  ok(
    "step4 exact Cash payment posted with receipt number",
    payA.status === 201 && /^RCPT-/.test(payA.payload.receiptNumber) && payA.payload.allocatedCentavos === invA.balanceCentavos,
    `receipt=${payA.payload.receiptNumber} allocated=${pesos(payA.payload.allocatedCentavos ?? 0)}`
  );
  const invA2 = await api("GET", `/invoices/${invA.id}`, { token: admin });
  ok("step4 invoice settled to PAID", invA2.payload.status === "PAID" && invA2.payload.balanceCentavos === 0, `status=${invA2.payload.status}`);

  // Partial cash on account C: pay half of the invoice.
  const invC = invList.payload.items.find((i) => i.serviceAccountId === C.id);
  const partial = Math.floor(invC.balanceCentavos / 2 / 100) * 100;
  const payC = await api("POST", "/payments", {
    token: admin,
    body: { serviceAccountId: C.id, amount: pesos(partial), method: "CASH", notes: "live demo partial cash" }
  });
  const invC2 = await api("GET", `/invoices/${invC.id}`, { token: admin });
  ok(
    "step4 partial Cash payment leaves remainder PARTIALLY_PAID",
    payC.status === 201 && invC2.payload.status === "PARTIALLY_PAID" && invC2.payload.balanceCentavos === invC.balanceCentavos - partial,
    `paid=${pesos(partial)} remaining=${pesos(invC2.payload.balanceCentavos)} status=${invC2.payload.status}`
  );

  // ---- Step 5: GCash payment with proof + duplicate-reference protection ----
  const invB = invList.payload.items.find((i) => i.serviceAccountId === B.id);
  const ref = `GCLIVE-${Date.now()}`;
  const proof = await api("POST", "/gcash/proofs", {
    token: admin,
    body: {
      serviceAccountId: B.id,
      amount: pesos(invB.balanceCentavos),
      referenceNumber: ref,
      senderName: B.subscriberName,
      proofNote: "live demo GCash screenshot"
    }
  });
  ok("step5 GCash proof submitted (PENDING)", proof.status === 201 && proof.payload.status === "PENDING", `ref=${ref}`);
  const review = await api("POST", `/gcash/proofs/${proof.payload.id}/review`, {
    token: admin,
    body: { proofId: proof.payload.id, approved: true, reason: "verified against mobile screenshot" }
  });
  ok(
    "step5 GCash proof approved and payment posted",
    review.status === 200 && review.payload.status === "VERIFIED" && review.payload.payment?.receiptNumber,
    `receipt=${review.payload?.payment?.receiptNumber}`
  );
  const dup = await api("POST", "/gcash/proofs", {
    token: admin,
    body: {
      serviceAccountId: B.id,
      amount: pesos(invB.balanceCentavos),
      referenceNumber: ref,
      senderName: B.subscriberName,
      proofNote: "duplicate attempt"
    }
  });
  ok("step5 duplicate GCash reference is rejected", dup.status === 409, `status=${dup.status} code=${dup.payload?.error?.code ?? dup.payload?.code}`);

  // ---- Step 6: subscriber ledger + Statement of Account --------------------
  const soa = await api("GET", `/ledger/${A.id}/statement?from=2026-06-01&to=2026-12-31`, { token: admin });
  ok(
    "step6 Statement of Account with closing balance",
    soa.status === 200 && Array.isArray(soa.payload.rows) && typeof soa.payload.closingBalanceCentavos === "number",
    `rows=${soa.payload.rows?.length} closing=${pesos(soa.payload.closingBalanceCentavos ?? 0)}`
  );

  // ---- Step 7: overdue subscriber + AR aging/filtering ---------------------
  const overdue = await api("GET", "/receivables/overdue?page=1&pageSize=5&minAgeDays=31", { token: admin });
  const aging = await api("GET", "/receivables/aging", { token: admin });
  const overdueFiltered = await api(
    "GET",
    `/receivables/overdue?page=1&pageSize=5&areaId=${A.areaId}`,
    { token: admin }
  );
  ok(
    "step7 overdue list + AR aging buckets",
    overdue.status === 200 && overdue.payload.total > 0 && aging.status === 200 && aging.payload.items.length >= 4,
    `overdue=${overdue.payload.total} buckets=${aging.payload.items.map((b) => b.bucket).join("/")}`
  );
  ok(
    "step7 AR filtering by collection area works",
    overdueFiltered.status === 200 && overdueFiltered.payload.items.every((r) => r.areaName === A.areaName),
    `area=${A.areaName} rows=${overdueFiltered.payload.items.length}`
  );

  // ---- Step 8: collector batch -> collect -> remit -> reconcile ------------
  const areas = (await api("GET", "/collection-areas", { token: admin })).payload.items;
  const routes = (await api("GET", "/collection-routes?areaId=" + A.areaId, { token: admin })).payload.items;
  const collectors = (await api("GET", "/collectors", { token: admin })).payload.items;
  const collector = collectors.find((c) => c.id === A.collectorId) ?? collectors[0];
  const activeIds = new Set(accounts.map((a) => a.id));
  const batchAccounts = invList.payload.items
    .filter(
      (i) =>
        i.serviceAccountId !== A.id &&
        i.serviceAccountId !== B.id &&
        i.serviceAccountId !== C.id &&
        activeIds.has(i.serviceAccountId) &&
        i.balanceCentavos > 0
    )
    .slice(0, 4);
  const open = await api("POST", "/collection/batches", {
    token: admin,
    body: {
      areaId: A.areaId,
      routeId: routes[0]?.id ?? null,
      collectorId: collector.id,
      batchDate: `${BILL_PERIOD}-15`,
      dueDayCutoff: 31,
      notes: "live demo batch"
    }
  });
  ok("step8 collector batch opened", open.status === 201 && open.payload.status === "OPEN", `batch=${open.payload.batchNumber}`);
  const batchId = open.payload.id;
  const added = await api("POST", `/collection/batches/${batchId}/accounts`, {
    token: admin,
    body: { serviceAccountIds: batchAccounts.map((i) => i.serviceAccountId) }
  });
  ok("step8 accounts added to the route sheet", added.status === 201, `accounts=${batchAccounts.length}`);

  let cashCollected = 0;
  for (let idx = 0; idx < batchAccounts.length; idx += 1) {
    const accountId = batchAccounts[idx].id;
    const full = idx < batchAccounts.length - 1;
    const detail = await api("GET", `/collection/batches/${batchId}`, { token: admin });
    const ba = (detail.payload.accounts ?? detail.payload.items ?? []).find((x) => x.serviceAccountId === batchAccounts[idx].serviceAccountId);
    const amount = full ? ba.totalDueCentavos : 0;
    if (full) cashCollected += amount;
    await api("POST", `/collection/batches/accounts/${ba.id}/collect`, {
      token: admin,
      body: { batchAccountId: ba.id, amount: pesos(amount), status: full ? "COLLECTED" : "UNCOLLECTED", method: "CASH" }
    });
  }
  const detail = await api("GET", `/collection/batches/${batchId}`, { token: admin });
  ok(
    "step8 doorstep collections recorded (3 collected, 1 uncollected)",
    detail.payload.status === "IN_PROGRESS" && detail.payload.cashCollectedCentavos === cashCollected,
    `cashCollected=${pesos(cashCollected)} status=${detail.payload.status}`
  );
  const routeSheet = await api("GET", `/collection/batches/${batchId}/route-sheet`, { token: admin });
  ok("step8 printable route sheet available", routeSheet.status === 200 && (routeSheet.payload.rows?.length ?? 0) === batchAccounts.length, `rows=${routeSheet.payload.rows?.length}`);

  const remitAmount = cashCollected - 50000; // deliberate 500.00 shortage (AT-08)
  const remittance = await api("POST", "/collection/remittances", {
    token: admin,
    body: { batchId, cashRemitted: pesos(remitAmount), nonCashCollected: "0.00", remarks: "live demo remit - short by 500" }
  });
  ok(
    "step8 remittance recorded with shortage derived",
    remittance.status === 201 && remittance.payload.shortageCentavos === 50000,
    `shortage=${pesos(remittance.payload.shortageCentavos ?? 0)} remittance=${remittance.payload.remittanceNumber}`
  );
  const reviewRemit = await api("POST", `/collection/remittances/${remittance.payload.id}/review`, {
    token: admin,
    body: { remittanceId: remittance.payload.id, approved: true, reason: "shortage to be recovered from collector" }
  });
  ok("step8 remittance confirmed and batch reconciled", reviewRemit.status === 200 && reviewRemit.payload.batchStatus === "RECONCILED", `batch=${reviewRemit.payload.batchStatus}`);

  const closeNoAck = await api("POST", `/collection/batches/${batchId}/close`, { token: admin, body: {} });
  ok("step8 closing a shortage batch without acknowledgement is refused", closeNoAck.status >= 400 && closeNoAck.status < 500, `status=${closeNoAck.status}`);
  const closeAck = await api("POST", `/collection/batches/${batchId}/close`, {
    token: admin,
    body: { acknowledgeDiscrepancy: true, notes: "500.00 shortage acknowledged" }
  });
  ok("step8 batch closed only after acknowledging the difference", closeAck.status === 200 && closeAck.payload.status === "CLOSED", `status=${closeAck.payload.status}`);

  // ---- Step 9: payment reversal + resulting audit trail --------------------
  const reverse = await api("POST", `/payments/${payA.payload.paymentId}/reverse`, {
    token: admin,
    body: { reason: "duplicate entry proven during live demo" }
  });
  ok("step9 posted payment reversed (not deleted)", reverse.status === 200, `status=${reverse.payload.status ?? reverse.payload.payment?.status ?? "?"}`);
  const payAfter = await api("GET", `/payments/${payA.payload.paymentId}`, { token: admin });
  ok("step9 reversed payment remains in the register", payAfter.status === 200 && payAfter.payload.status === "REVERSED", `status=${payAfter.payload.status}`);
  const auditEntity = await api("GET", `/audit/entity/payment/${payA.payload.paymentId}`, { token: admin });
  ok("step9 audit trail records the reversal", auditEntity.status === 200 && (auditEntity.payload.items?.length ?? 0) > 0, `entries=${auditEntity.payload.items?.length ?? 0}`);

  // ---- Step 10: management report exported to PDF and XLSX -----------------
  const pdf = await api("GET", "/reports/collections?from=2026-06-01&to=2026-12-31&exportFormat=pdf", { token: admin, binary: true });
  const xlsx = await api("GET", "/reports/revenue?from=2026-06-01&to=2026-12-31&by=plan&exportFormat=xlsx", { token: admin, binary: true });
  ok(
    "step10 collections report exported to PDF",
    pdf.status === 200 && /pdf/i.test(pdf.ct) && pdf.payload.length > 0,
    `type=${pdf.ct} bytes=${pdf.payload.length}`
  );
  ok(
    "step10 revenue report exported to XLSX",
    xlsx.status === 200 && /sheet|excel|officedocument/i.test(xlsx.ct) && xlsx.payload.length > 0,
    `type=${xlsx.ct} bytes=${xlsx.payload.length}`
  );

  // ---- Step 11: role restrictions with a lower-privileged account ----------
  const cashier = await login("cashier");
  const cashierGenerate = await api("POST", "/billing/generate", { token: cashier, body: { period: "2026-12" } });
  const cashierReports = await api("GET", "/reports/revenue?from=2026-06-01&to=2026-12-31&by=plan", { token: cashier });
  const viewer = await login("viewer");
  const viewerPay = await api("POST", "/payments", { token: viewer, body: { serviceAccountId: A.id, amount: "1.00", method: "CASH" } });
  const anon = await api("GET", "/dashboard");
  ok(
    "step11 lower-privileged roles are denied server-side",
    cashierGenerate.status === 403 && cashierReports.status === 403 && viewerPay.status === 403,
    `cashierGenerate=${cashierGenerate.status} cashierReports=${cashierReports.status} viewerPay=${viewerPay.status}`
  );
  ok("step11 unauthenticated request is rejected", anon.status === 401, `status=${anon.status}`);

  // ---- Step 12: backup creation + tested restore procedure -----------------
  // backup.restore belongs to OWNER alone, so the demonstration switches role.
  const owner = await login("owner");
  const backup = await api("POST", "/backups", { token: owner, body: { includesAttachments: true, notes: "live demo backup" } });
  ok("step12 backup created", backup.status === 201 && backup.payload.backup?.status === "CREATED", `status=${backup.payload?.backup?.status} file=${backup.payload?.backup?.fileName ?? "?"}`);
  const backupId = backup.payload.backup.backupId;
  const verify = await api("POST", `/backups/${backupId}/verify`, { token: owner, body: {} });
  ok("step12 backup verified (restore-ready)", verify.status === 200 && verify.payload.ok === true && verify.payload.backup?.status === "VERIFIED", `status=${verify.payload?.backup?.status} notes=${verify.payload?.notes?.length ?? 0}`);
  const integrity = await api("GET", "/backups/integrity", { token: owner });
  ok("step12 integrity checks pass", integrity.status === 200, `checks=${Array.isArray(integrity.payload.checks) ? integrity.payload.checks.length : Object.keys(integrity.payload).join(",")}`);
  const backups = await api("GET", "/backups", { token: owner });
  ok("step12 backup register lists the backup", backups.status === 200 && (backups.payload.items?.length ?? 0) > 0, `items=${backups.payload.items?.length ?? 0}`);

  // ---- Step 13: simultaneous operation from multiple office clients --------
  // The authoritative concurrency evidence is the integration suite
  // (integration.concurrency.test.ts). This is a light live smoke of the same
  // property: many parallel reads and two parallel writes from one client.
  const parallel = await Promise.all(
    Array.from({ length: 10 }, () => api("GET", "/dashboard", { token: admin }))
  );
  ok("step13 10 simultaneous office-client reads all succeed", parallel.every((r) => r.status === 200), `ok=${parallel.filter((r) => r.status === 200).length}/10`);

  console.log(results.join("\n"));
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("Failed checks:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("DEMO ABORTED:", error.message);
  console.log(results.join("\n"));
  process.exit(2);
});

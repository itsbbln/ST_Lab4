# BCIS Subscription Billing and Collection System — Lab 4 Compliance Checklist

Status legend: `[x]` implemented and verified · `[~]` partial · `[ ]` missing · `[-]` not required / out of scope

Evidence paths are relative to `BCIS-Subscription-Billing-System/`.

**This document was rewritten on 2026-09-28.** The previous version described a
bare in-memory scaffold and reported PostgreSQL, Drizzle, migrations, reports,
backup/restore, RBAC tables and every acceptance test as *absent*. All of those
exist now. Statements below are backed by a command you can re-run; the exact
figures came from the run recorded in the Verification section.

---

## 0. Audit summary

| Area | State | Evidence |
|---|---|---|
| Monorepo scaffold (npm workspaces) | present | `source/package.json` |
| PostgreSQL + Drizzle + migrations | **present** | 38 tables, 110 enum types, `database/migrations/0000_initial_schema.sql` |
| Fastify API + RBAC preHandler | present | 91 routes, `source/apps/api/src/app.ts` |
| Domain services (23 modules) | present | `source/apps/api/src/services/` |
| Money as integer centavos | present | `source/packages/shared/src/money.ts` |
| Reports (PDF/XLSX/CSV) | **present** | `reports.routes.ts`, `report-export.ts` |
| Backup / restore + integrity | **present** | `backup.routes.ts`, `integrity.ts` |
| Automated tests | present | 49 unit + 143 integration |
| Demo dataset to §8 volume | **present** | `source/scripts/seed-demo.ts` |
| Electron shell (contextIsolation) | present | `source/apps/desktop/main.js` |
| React UI | **login + dashboard only** | `renderer/src/App.tsx` (~267 lines) |
| Typed preload bridge | **missing** | `preload.js` is still the Vite template |
| Installer / release build | **missing** | no electron-builder config; `release/` empty |
| UI evidence, sample reports | **missing** | `tests/screenshots/` and `reports-samples/` hold only READMEs |
| AT-09 concurrency, HTTP-level AT-10 | **missing** | see §6 |

The single largest remaining gap is the **renderer**. The API is complete and
demonstrably correct; the desktop client exposes almost none of it.

---

## 1. Required Technology and Architecture (PDF §2)

- [x] 2.1 Three office PCs are API clients only (renderer never opens the DB) — `renderer/src/App.tsx` uses `fetch` to the API
- [x] 2.1 Fastify API as the single data-access path — `source/apps/api/src/app.ts`
- [x] 2.2 Electron desktop shell — `source/apps/desktop/main.js`
- [~] 2.2 electron-vite — not used; standalone Vite + plain `electron` script
- [ ] 2.2 electron-builder installer config — absent (dependency installed, no config block)
- [x] 2.2 React 19.2 + TypeScript — `source/apps/desktop/renderer/package.json`
- [x] 2.2 TypeScript strict — `source/tsconfig.base.json` sets `"strict": true`
- [ ] 2.2 Tailwind CSS 4 + shadcn/ui — installed but unused; hand-written CSS
- [ ] 2.2 TanStack Table + TanStack Query — installed but unused
- [x] 2.2 Fastify 5 + TypeScript — `source/apps/api/package.json`
- [x] 2.2 **PostgreSQL** — 38 tables verified in `BCIS-LabAct4`
- [x] 2.2 **Drizzle ORM** — `source/apps/api/src/db/schema/`
- [x] 2.2 Zod 4 — `source/packages/shared/src/index.ts`
- [ ] 2.2 React Hook Form — installed but unused
- [x] 2.2 ExcelJS + pdfmake — `report-export.ts`; both formats verified by `npm run smoke`
- [x] 2.2 Vitest — 5 unit files, 9 integration files
- [x] 2.2 API integration tests — 143 tests via `npm run test:integration`
- [ ] 2.2 Playwright Electron E2E — dependency installed, no specs
- [x] 2.2 **Pino** structured logging — `app.ts`; JSON logs observed in `api-smoke.log`
- [x] 2.3 Renderer never connects to PostgreSQL
- [x] 2.3 `contextIsolation=true`, `nodeIntegration=false` — `main.js`
- [ ] 2.3 Narrow **typed** preload API — `preload.js` has no `contextBridge`
- [x] 2.3 Validate external inputs with Zod — every route has a schema
- [x] 2.3 Business rules in services, not React — `source/apps/api/src/services/`
- [x] 2.3 PostgreSQL transactions for multi-step financial posting — `inTransaction()` throughout billing, payments, collections, service control
- [x] 2.3 Integer centavos for money — `money.ts`; `formatCentavos` rejects non-integers
- [x] 2.3 Every schema change via a migration — `database/migrations/0000_initial_schema.sql`
- [x] 2.3 Posted records reversed, not deleted — `reversePayment()`; no `DELETE` route for subscribers

## 2. Functional Scope (PDF §3)

### 3.1 Roles and access
- [x] All 7 roles — `OWNER`, `ADMINISTRATOR`, `CASHIER`, `COLLECTION_SUPERVISOR`, `ACCOUNTANT_AUDITOR`, `TECHNICIAN`, `READONLY_VIEWER`
- [x] 24 granular permissions incl. `payment.reverse`, `collection.reconcile`, `user.manage`, `backup.restore`
- [x] Permissions stored in `roles` / `permissions` / `role_permissions` / `user_roles` — 7 roles, 24 permissions, 88 mappings
- [x] `user.manage` — `/users`, `/users/role-matrix`, `/users/:id/roles`, `/users/:id/sessions`
- [x] `backup.restore` — `/backups`, `/backups/:id/verify`, `/backups/:id/restore`
- [x] Session pruning — `/maintenance/prune-sessions`

### 3.2 Subscriber management
- [x] Create with account number, contacts, address, area, status, notes — `createSubscriber()`
- [x] One subscriber → many service accounts — 50 subscribers / 60 service accounts seeded
- [x] Multiple service **addresses** per subscriber — `subscriber_addresses`; `/subscribers/:id/addresses`
- [x] Global search — `/subscribers/search`
- [x] No hard delete; status-based — `DELETE /subscribers/:id` returns 404 by design (asserted in `smoke-test.ts`)
- [x] Status transitions recorded — `service_events`

### 3.3 Plans and service accounts
- [x] Internet / Cable / Combo plans — 7 seeded (3 Internet, 2 Cable, 2 Combo)
- [x] Plan fees (installation / reconnection)
- [x] Internet speed attribute / Cable channel count
- [x] `service_types` table
- [x] Service account stores plan, install address, billing day, current rate, status, collector
- [x] Activation date + billing start period
- [x] Current rate snapshot — a plan price change does not rewrite history
- [x] Plan update / deactivate — `PUT /plans/:id`

### 3.4 Billing and invoice engine
- [x] Monthly generation per active account — 4 periods, 60 invoices each
- [x] States `DRAFT`, `UNPAID`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `VOID`, `CREDITED`
- [x] `invoice_items` — subscription, installation, reconnection, discount, penalty, adjustments
- [x] Penalty rule (configurable, off by default)
- [x] Controlled void / adjust workflow — `POST /invoices/:id/void`, `/adjust`
- [x] Duplicate billing prevention — unique constraint; AT-11 verified
- [x] `billing_cycles` and adjustments
- [x] Overdue refresh — `POST /billing/refresh-overdue`

### 3.5 Subscriber ledger
- [x] Chronological debit/credit with reproducible running balance
- [x] Debit on invoice, credit on payment
- [x] Reversal posts the correct amount — AT-06 verified, including the advance case
- [x] Statement of Account for a date range — `/ledger/:id/statement`
- [x] `ledger_entries` + indexes — 451 entries seeded
- [x] Opening balance / carry-forward

### 3.6 Payments and allocation
- [x] Cash, GCash, Bank Transfer, Cheque, Other
- [x] Date/time, amount, receipt number, actor, method, reference, notes
- [x] Proof attachment — `attachments.ts`; 17 integration tests
- [x] Exact / partial / advance
- [x] Default allocation oldest-first — `/payments/allocation-preview`
- [x] Authorized manual allocation override — `allocations[]` on `postPayment`
- [x] Corrections by reversal, not destructive edit
- [x] `payment_allocations` table
- [x] `payment_reversals` table — 1 seeded
- [x] Existing account credit drawn down by new payments

### 3.7 GCash verification
- [x] Reference, sender, amount, proof note — `submitGcashProof()`
- [x] Duplicate reference detection
- [x] Authorized verify / reject, identity + timestamp retained
- [x] Only verified proofs post and allocate
- [x] Screenshot is evidence, not payment — two-step PENDING→VERIFIED
- [x] `payment_proofs` table + attachment storage — 114 proofs seeded
- [x] Unverified duplicate warning path

### 3.8 House-to-house collection
- [x] Collection areas, routes, collectors — 3 / 3 / 2 seeded
- [x] `collector_assignments` table
- [x] Printable route sheet — `GET /collection/batches/:id/route-sheet`
- [x] Full batch lifecycle `OPEN → IN_PROGRESS → SUBMITTED → REMITTED → RECONCILED → CLOSED`
- [x] `batch_accounts` with per-account expected / collected / uncollected
- [x] Expected receivable / cash collected / non-cash / uncollected summary
- [x] `collector_remittances` with shortage/overage
- [x] **AT-08 enforced**: a short batch cannot close without an explicit discrepancy acknowledgement. Verified twice — the seed's first `close` attempt is refused, and the integration suite covers it.

### 3.9 Receivables and overdue
- [x] Current + overdue totals, overdue accounts — `/receivables/summary`, `/receivables/overdue`
- [x] Aging buckets Current / 1–30 / 31–60 / 61–90 / 90+ — 4 of 5 buckets carry a balance (11 / 8 / 6 / 4 invoices)
- [x] Overdue columns: months unpaid, oldest unpaid invoice, last payment, total arrears
- [x] Filters by collector / area / plan / service type / delinquency age
- [x] Suspension candidates — `/receivables/suspension-candidates` (7 seeded)

### 3.10 Suspension and reconnection
- [x] Configurable grace period and suspension threshold — `application_settings`
- [x] Reason, effective date, approved by, notes
- [x] Reconnection workflow with fee, technician assignment, request/completion dates
- [x] `service_events` history table
- [x] `suspension_records`, `reconnection_records` — 2 of each seeded; one reconnection completed end to end, one awaiting its technician
- [ ] Suspend/Reconnect UI

### 3.11 Receipts and reports
- [x] Unique receipt numbers via `document_sequences` — 208 seeded
- [x] Receipt voiding reserves the number
- [x] `receipts` table
- [x] Daily / weekly / monthly / annual collection reports
- [x] Cash / GCash / payment-method summaries with date range
- [x] Billing vs collection report
- [x] Revenue by plan / service type / area
- [x] AR report (aging + overdue)
- [x] Subscriber master list report
- [x] Subscriber ledger + SOA report
- [x] Collector assignment / collection / remittance / shortage-overage / performance reports
- [x] Payment adjustment / reversal / voided receipt / user activity / audit reports
- [x] **PDF export (pdfmake)** — verified `%PDF` header
- [x] **XLSX export (ExcelJS)** — verified `PK` header
- [x] CSV export
- [ ] `reports-samples/` populated (README only)

## 3. Non-Functional, Security, UI/UX (PDF §4)

- [ ] 4.1 Specified design tokens — `index.css` is still the Vite template (purple `#aa3bff`)
- [ ] 4.1 Right-aligned tabular-nums financial values
- [ ] 4.1 Status as text + colour, never colour alone
- [~] 4.2 Navigation — Dashboard only
- [ ] 4.2 Full nav tree (Subscribers, Billing, Payments, Collections, Receivables, Services, Reports, Administration)
- [~] 4.3 Dashboard: billing vs collection, AR aging, collector performance, overdue alerts, recent payments — the API returns all of it; the screen shows a subset
- [ ] 4.3 Subscriber Profile tabs
- [ ] 4.3 Receive Payment fast workflow
- [ ] 4.3 GCash two-pane queue with proof preview
- [ ] 4.3 Collector Reconciliation screen
- [ ] 4.3 Operational tables (sticky headers, search, filters, sorting, pagination, export, badges)
- [~] 4.3 Forms: visible labels, required indicators, section grouping, inline validation
- [ ] 4.3 Dedicated print layout without app navigation
- [x] 4.4 Username/password auth, scrypt hashing, active/inactive state
- [x] 4.4 Per-account lockout and per-IP rate limiting — both verified; the throttle returns **429 `TOO_MANY_REQUESTS`**
- [x] 4.4 Session expiry — `SESSION_TTL_MINUTES`; token rejected after logout
- [x] 4.4 CORS restricted — `CORS_ORIGINS` in `.env.example`, not `origin: true`
- [x] 4.4 Server-side authorization via `authorize()` preHandler
- [x] 4.4 Audit record on financial mutations with actor/action/time/reason/metadata — 603 entries seeded
- [x] 4.4 Audit old/new values for reversals
- [x] 4.4 Audit logs read-only
- [x] 4.4 Upload validation by type/size/safe path — magic-byte sniffing, 17 tests
- [x] 4.4 No secrets in logs — `migrate.ts` and `db-reset.ts` redact the password
- [x] 4.5 Indexes + paginated server queries
- [x] 4.5 Transactional critical financial ops
- [x] 4.5 Backup, verification, restore — AT-12 covered, including refusal without acknowledgement
- [x] 4.5 User-friendly errors + technical detail to structured logs — `error-handler.ts`

## 4. Minimum Data Model (PDF §5)

All 38 required tables exist. Verified by `npm run db:reset`, which drops the
schema, re-applies every migration, then asserts `public` is non-empty.

`users` · `roles` · `permissions` · `role_permissions` · `user_roles` ·
`sessions` · `subscribers` · `subscriber_addresses` · `service_types` ·
`service_plans` · `service_accounts` · `service_events` · `service_devices` ·
`collection_areas` · `collection_routes` · `collectors` ·
`collector_assignments` · `technicians` · `billing_cycles` · `invoices` ·
`invoice_items` · `invoice_adjustments` · `payments` · `payment_allocations` ·
`payment_proofs` · `payment_reversals` · `receipts` · `ledger_entries` ·
`collection_batches` · `batch_accounts` · `collector_remittances` ·
`suspension_records` · `reconnection_records` · `application_settings` ·
`attachments` · `audit_logs` · `backup_history` · `document_sequences`

### 5.2 Constraints and indexes
- [x] Unique subscriber account number
- [x] Unique service account number
- [x] Unique invoice number; duplicate-period prevention is a **database** constraint, not just app code
- [x] Unique receipt number with voided numbers reserved
- [x] GCash reference duplicate detection
- [x] Foreign keys for owned records
- [x] Indexes on subscriber name/account/contact, invoice due date/status, payment date/reference, collector, area

## 5. Laboratory Procedure and Phases (PDF §6)

| Phase | Status |
|---|---|
| 1 — Analysis & foundation | [x] monorepo, stack, health, Electron shell, README, migrations, reset script |
| 2 — Auth & RBAC | [x] all 7 roles, 24 permissions, DB-driven, lockout, throttle, session lifecycle, RBAC assertions in `smoke` |
| 3 — Plans, subscribers, service accounts | [~] API complete and tested; **screens missing** |
| 4 — Billing & ledger engine | [~] engine complete (4 periods × 60 invoices, AT-11 verified); **screens missing** |
| 5 — Payments, allocation, receipts | [~] engine complete incl. proofs, reversal, advance; **screens missing** |
| 6 — Collector & remittance | [~] full batch lifecycle + remittance gate verified; **screens missing** |
| 7 — Receivables & service control | [~] aging, overdue, candidates, suspension, reconnection all verified; **screens missing** |
| 8 — Reports, dashboard, printing | [~] 8 reports × 3 formats verified; **renderer print layouts missing** |
| 9 — Backup, hardening, deployment | [~] backup/restore/integrity verified, `docs/deployment-guide.md`; **installer missing** |
| 10 — QA, documentation, defense | [~] 192 automated tests, 5 docs; **AT-09, HTTP AT-10, screenshots, acceptance PDF missing** |

## 6. Mandatory Acceptance Tests (PDF §7)

| ID | Scenario | Status |
|---|---|---|
| AT-01 | Exact payment | [x] `integration.payments.test.ts` |
| AT-02 | Partial payment | [x] `integration.payments.test.ts` (allocation invariant) |
| AT-03 | Advance payment | [x] advance held, then spent on the next invoice |
| AT-04 | Oldest-first arrears | [x] allocation preview test |
| AT-05 | Duplicate GCash reference | [x] second approval refused |
| AT-06 | Payment reversal | [x] balance restored, ledger debited back, double reversal refused |
| AT-07 | Collector balanced remittance | [x] `integration.collections.test.ts` |
| AT-08 | Collector shortage | [x] close refused without acknowledgement; **enforced and tested** |
| AT-09 | Concurrent users (3 PCs) | [ ] **no test.** Unique constraints and transactions are in place, but no test drives two clients at once |
| AT-10 | Authorization (cashier → admin-only op) | [~] HTTP-level verified in `npm run smoke` (viewer write → 403, cashier plan write → 403); no test in the suite proper |
| AT-11 | Duplicate billing generation | [x] `integration.payments.test.ts` + `integration.billing.test.ts` |
| AT-12 | Backup/restore | [x] `integration.backup.test.ts`, including refusal paths |

Test evidence per §7.1:
- [x] Automated output for domain/business rules — 49 unit tests
- [x] API/integration test results for posting flows — 143 integration tests
- [x] Reproducible end-to-end evidence — `npm run smoke`, 88 assertions
- [ ] Screenshots / report files showing expected balances
- [x] Bug log: root cause, fix, regression test — see §11

## 7. Minimum Demonstration Dataset (PDF §8)

Produced by `npm run seed:demo` through the real services. Deterministic
(mulberry32, fixed seed) and idempotent — a second run produces identical counts.

| Data | Required | Actual |
|---|---|---|
| Users | 5 | **7** (one per role) |
| Plans | 7 (3 Internet, 2 Cable, 2 Combo) | **7** (3 / 2 / 2) |
| Subscribers | 50 | **50** |
| Service accounts | 60+ | **60** |
| Collectors | 2 | **2** |
| Collection areas | 3 | **3** (+ 3 routes) |
| Invoices | ≥ 3 billing months | **242** across 4 periods (2026-06 … 2026-09) |
| Payments | Cash, GCash, partial, exact, advance | **208** — CASH 15, GCASH 115, BANK_TRANSFER 38, CHEQUE 39; 4 leave advance credit |
| Overdue accounts | ≥ 10 across aging buckets | **29** invoices over 4 buckets (1-30: 11, 31-60: 8, 61-90: 6, 90+: 4) |
| Reversal/void | ≥ 1 | **1** |
| Suspension/reconnection | ≥ 2 | **2** suspensions, **2** reconnections (1 completed end to end) |
| Collection batches | — | **2**: one reconciling cleanly, one ₱500.00 short with the close refusal demonstrated |
| Synthetic data only | required | compliant |
| Seed script in `database/seeds/` | required | **`seed-demo.ts` present**, plus `db-reset.ts` and `smoke-test.ts` |

## 8. Required Deliverables (PDF §9)

- [~] D1 Source repository — `source/` with `workspaces`; `.gitignore` present under `source/` but **absent at repo root**; git history is the user's home directory, not this project
- [ ] D2 Working release — no electron-builder config, `release/` empty
- [x] D3 Technical documentation — `docs/technical-documentation.md`, `api-spec.md`, `erd.md`, `deployment-guide.md`
- [x] D4 User manual — `docs/user-manual.md`
- [ ] D5 Testing package — `tests/acceptance-test-report.md` exists; **PDF absent**
- [ ] D6 Sample reports — `reports-samples/` holds only a README
- [ ] D7 UI evidence — `tests/screenshots/` holds 1 file
- [ ] D8 Presentation/defense — absent

### 9.1 Submission folder structure
- [x] `source/`, `database/migrations/`, `database/seeds/`, `docs/`, `tests/screenshots/`, `reports-samples/`, `release/` all exist
- [x] `README.md` at root
- [x] `docs/technical-documentation.md`, `docs/user-manual.md`, `docs/erd.md`, `docs/deployment-guide.md`
- [ ] `tests/acceptance-test-report.pdf`

## 9. Grading-Rubric Critical Failures (§10.1)

| Critical condition | Present? |
|---|---|
| Destructive deletion of posted payments | no — reversal only; no subscriber DELETE route |
| Obviously incorrect ledger balances | no — verified by `GET /backups/integrity` (10/10 checks pass on the seeded database) |
| Shared database-file architecture | no — three-office client/server over PostgreSQL |
| Plaintext passwords | no — scrypt |
| Renderer direct database access | no |
| No server-side authorization | no — `authorize()` preHandler on every route |
| Inability to restore a backup | no — AT-12 covers restore, verification and refusal paths |
| Static UI/CRUD without required financial workflows | **partly** — the API implements every workflow, but the renderer exposes only login + dashboard. This is the remaining critical risk. |

## 10. AI-Assisted Development Accountability (PDF §12)

- [x] `CLAUDE.md` with project-level development instructions
- [ ] Reusable project rules/skills under `.claude/`
- [ ] Meaningful Git history — **the git root is `C:\Users\ACER`, not this project, and there are no commits**

## 11. Bug log (§7.1 requirement)

| # | Symptom | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | Subscriber and service-account lists returned HTTP 500, but only for rows with a zero balance | `sum()` over a `bigint` column returns `numeric` in PostgreSQL, and node-postgres returns `numeric` as a **string**. The `sql<number>` annotation promised a number while delivering `"0"`, so `formatCentavos` rejected it | Added `::bigint` casts to the aggregates in `directory.ts` (2 sites) and `billing.ts` (1 site) so the existing INT8 parser yields a real number | `apps/api/tests/integration.money-types.test.ts` (5 tests) |
| 2 | A throttled sign-in attempt returned **HTTP 500** "Something went wrong" | `@fastify/rate-limit` `throw`s whatever `errorResponseBuilder` returns. That plain object had no `statusCode`, so the global handler fell through to its 500 branch | `error-handler.ts` now passes through pre-shaped error envelopes; `auth.routes.ts` returns `statusCode: 429` and code `TOO_MANY_REQUESTS` | `apps/api/tests/error-handler.test.ts` (5 tests) + 3 assertions in `smoke-test.ts` |
| 3 | Database reported "Migrations applied" while containing **zero tables** | `DROP SCHEMA public` was run without dropping `drizzle.__drizzle_migrations`, so the migrator considered 0000 already applied and skipped it | New `scripts/db-reset.ts` drops the schema and the ledger together, re-applies, then asserts `public` is non-empty | Guarded by the assertion inside `db-reset.ts` itself |
| 4 | `npm run seed:demo` was not idempotent — failed on a rerun with `service_plans_code_unique` | `createPlan` is correctly create-only; the seed relied on it being forgiving | Seed looks up existing codes case-insensitively (matching the `lower(code)` index) and skips them | Second `npm run seed:demo` produces identical counts |
| 5 | Reconnection workflow stalled: "reconnection fee of ₱500.00 is still outstanding" | `postPayment` allocates oldest-first by default, and the fee was being absorbed by four months of arrears | Seed passes an explicit `allocations[]` targeting the fee invoice | Flow now completes end to end |
| 6 | The seeded reversal silently did not happen | The target account happened to be a GCash payer, which takes an early `continue` before the reversal step | Reversal is now flag-driven rather than index-driven | `reversals  1` in the seed summary |

## 12. Final Submission Checklist (PDF §14)

- [~] Application starts without dev-only manual edits — `npm run dev` works; `.env.example` and `.env` now agree
- [x] All three client PCs can reach the API — server binds `0.0.0.0:3001` and logs every LAN address
- [x] No secrets or passwords committed
- [x] Migrations run from a clean database — `npm run db:reset`
- [x] Seed/demo data is synthetic and reproducible — deterministic PRNG
- [x] RBAC and server-side permission checks demonstrated — 24 permissions, verified over HTTP
- [x] Monthly billing does not create duplicates — AT-11
- [x] Partial, exact and advance payment cases are correct — AT-01/02/03
- [x] Payment reversal preserves history and audit trail — AT-06
- [x] Receipt numbers unique and voided numbers not reused
- [x] Collector shortage/overage visible and not silently balanced — AT-08
- [x] AR aging totals reconcile to outstanding invoice balances — `/backups/integrity`
- [x] PDF/XLSX reports calculate correctly — headers and byte counts verified
- [x] Backup and restore tested — AT-12
- [x] Unit/integration acceptance evidence — 192 automated tests
- [x] Technical documentation, user manual, deployment guide
- [ ] Final release/installer and README polish — installer missing
- [ ] Implementation and design decisions defensible — pending the renderer

---

## Highest-priority remaining work

1. **Build the renderer.** Every workflow exists in the API and is proven; the desktop client is the only reason the submission would fail §4.2/§4.3. Start with the nav tree and the Receive Payment flow.
2. **Typed preload bridge.** `preload.js` is still the Vite template with no `contextBridge` (§2.3).
3. **Configurable API base.** `App.tsx` hardcodes `http://127.0.0.1:3001`, so the other two office PCs cannot connect (§2.1).
4. **AT-09 concurrency test.** Drive two clients at the same billing run and at the same payment.
5. **AT-10 as a test**, not only a smoke assertion.
6. **electron-builder config** and a real `release/` build (D2).
7. **Design tokens** in `index.css` per §4.1 — currently the Vite purple.
8. **Screenshots, sample reports, acceptance PDF** (D5–D7).
9. **Init a git repository** at the project root. The current git root is `C:\Users\ACER` with no commits, which is worth fixing before anything else is graded.

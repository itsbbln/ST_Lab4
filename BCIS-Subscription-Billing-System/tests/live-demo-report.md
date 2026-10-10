# BCIS Testing Report — Phases and §11.1 Live Demo

Evidence for the BCIS Subscription Billing and Collection System laboratory submission.
All commands were run from `source/` unless noted. Database: PostgreSQL 17, `BCIS-LabAct4`.

## Environment

- API: Fastify service at `http://127.0.0.1:3001` (`npm run dev:api`), PostgreSQL 17.
- Seeded accounts (password `Bcis@2026`): `owner`, `admin`, `cashier`, `supervisor`, `auditor`, `technician`, `viewer`.
- Integration tests run against `bcis_test` (the runner refuses any database not ending in `_test`).
- Unit tests exclude `tests/integration.*.test.ts` unless `BCIS_INTEGRATION=1`.

## Verification Summary

| Suite | Command | Result | Evidence |
| --- | --- | --- | --- |
| Unit / regression | `npm test` | 55 passed (7 files) | API services, error handling, report export, CORS, HTTP authorization (AT-10) |
| Integration (PostgreSQL) | `npm run test:integration` | 146 passed (10 files) | Billing, payments, collections, receivables, reports, backup, dashboard, service control, attachments, money types, concurrency |
| HTTP smoke | `npm run smoke` | 88 passed, 0 failed | Health, 7 logins, 24 permissions, RBAC 401/403, seeded-data screens, reports/integrity |
| Minimum demo dataset (§8) | `psql` checks | Passed | 7 users, 50 subscribers, 60 accounts, 3 areas/2 collectors, 7 plans, 4 billing periods, 208 payments, 1 reversal, 2 suspension/reconnection scenarios, 2 batches |
| Required live demo (§11.1) | `live-demo.mjs` over HTTP | 39 passed, 0 failed | All 13 steps below |

The concurrency evidence for AT-09 is `source/apps/api/tests/integration.concurrency.test.ts`:
- two simultaneous billing runs create exactly one invoice per account;
- three simultaneous cash payments receive distinct `RCPT-YYYY-NNNNNN` numbers with no cross-account allocation;
- two simultaneous approvals of one GCash reference post exactly one payment.

## §8 Minimum Demo Dataset (verified)

- Users/roles: 7 users, one per role; 24 permissions, 88 role-permission mappings.
- Service types/plans: INTERNET (3 plans), CABLE (2), COMBO (2).
- Directory: 3 collection areas, 3 routes, 2 collectors, 2 technicians.
- Subscribers/accounts: 50 subscribers, 60 service accounts.
- Billing: 2026-06..2026-09 fully billed (60 invoices each) plus intentional `REC-2026-10` reconnection-fee invoices.
- Payments: 208 posted (Cash, GCash, Bank transfer, Cheque) including partial, exact and advance-leaving payments.
- Control data: 1 payment reversal, 2 suspension/reconnection scenarios, 2 collection batches (one balanced AT-07, one with a ₱500 shortage AT-08).
- Overdue: 11 accounts spanning D1_30, D31_60, D61_90 and D90_PLUS aging buckets.

## §11.1 Required Live Demo Sequence

Script: `source/scripts/live-demo.mjs` exercising the running API over HTTP. Result: 39/39 checks passed.

| # | Required step | Result | Observed evidence |
| --- | --- | --- | --- |
| 1 | Log in as administrator and show the dashboard | Pass | Dashboard totals: 60 accounts, ₱40,871.00 receivables |
| 2 | Create/open a subscriber with Internet/Cable service account | Pass | Anselmo Salazar / Fiber 10 Mbps (INTERNET) |
| 3 | Generate/display monthly invoice and ledger debit | Pass | Billing run `2026-11` created 59 invoices; INV-2026-000285 ₱999.00 matched the ledger balance and cycle summary |
| 4 | Post exact/partial Cash payment and preview receipt | Pass | Exact cash RCPT-2026-000209 settled to PAID; partial cash left PARTIALLY_PAID with ₱500.00 remaining; allocation preview returned expected lines |
| 5 | Post/verify GCash payment with proof and duplicate-reference protection | Pass | Proof approved and posted (RCPT-2026-000211); duplicate reference rejected with `409 DUPLICATE_REFERENCE` |
| 6 | Show subscriber ledger and Statement of Account | Pass | Statement returned 7 rows with opening/closing balances |
| 7 | Open an overdue subscriber and demonstrate AR aging/filtering | Pass | 11 overdue accounts across all buckets; area filter returned only matching rows |
| 8 | Collector batch: collect, remit Cash, reconcile the difference | Pass | Batch BATCH-2026-000003: 4 accounts, ₱15,990.00 cash collected, ₱500.00 shortage derived, confirmed → RECONCILED, close refused without acknowledgement (422), closed with acknowledgement |
| 9 | Payment reversal and audit trail | Pass | Payment reversed (not deleted) → status REVERSED; audit trail shows 2 entries for the payment |
| 10 | Management report exported to PDF/XLSX | Pass | Collections PDF (`application/pdf`, 3,455 bytes); Revenue XLSX (`...spreadsheetml.sheet`, 7,022 bytes) |
| 11 | Role restrictions with a lower-privileged account | Pass | Cashier denied billing generation and reports (403); viewer denied payment creation (403); anonymous denied (401) |
| 12 | Backup creation and tested restore procedure | Pass | Backup BK-20261009-150845-9e988a.dump created and VERIFIED (3 checks); integrity suite returned 10 checks; register lists the backup |
| 13 | Simultaneous operation from multiple office clients | Pass | 10 parallel authenticated dashboard reads all succeeded; authoritative evidence is the AT-09 integration suite |

## Phase Coverage

| Phase | Feature area | Covered by |
| --- | --- | --- |
| 1 | Auth, roles, permissions, audit | `npm run smoke`, `authorization.http.test.ts`, `integration.*.test.ts` |
| 2 | Subscribers, addresses, plans, service accounts | `directory.routes.ts` flows, smoke seeded-data assertions |
| 3 | Billing cycles, invoice generation, void/adjust | `billing.test.ts`, `integration.reports.test.ts`, live demo step 3 |
| 4 | Payments, allocation, receipts, reversals | `integration.payments.test.ts`, live demo steps 4 and 9 |
| 5 | GCash proofs and verification | `integration.payments.test.ts`, live demo step 5 |
| 6 | Ledger, statement of account, receivables/aging | `integration.receivables.test.ts`, live demo steps 6–7 |
| 7 | Collection batches, remittance, reconciliation | `integration.collections.test.ts`, live demo step 8 |
| 8 | Service control (suspend/disconnect/reconnect) | `integration.service-control.test.ts` |
| 9 | Reports and exports, dashboard, backups/integrity | `integration.reports.test.ts`, `integration.dashboard.test.ts`, `integration.backup.test.ts`, live demo steps 10 and 12 |
| 10 | Hardening, concurrency, multi-office operation | `integration.concurrency.test.ts`, `authorization.http.test.ts`, live demo step 11 and 13 |

## How to Reproduce

1. `npm run db:reset`
2. `npm run seed:demo`
3. `npm test`
4. `npm run test:integration`
5. Start the API (`npm run dev:api`) and run `npm run smoke`.
6. Run the §11.1 HTTP walkthrough (`node scripts/live-demo.mjs`) against the running API.
7. Reset and reseed afterwards (`npm run db:reset; npm run seed:demo`) to restore clean demo state.

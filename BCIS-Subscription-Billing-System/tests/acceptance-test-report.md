# Acceptance Test Report

This file is the source for the submission artifact `tests/acceptance-test-report.pdf`.

## Verification Summary

- Prepared for the BCIS Subscription Billing and Collection System laboratory submission.
- The PDF deliverable is generated from this Markdown with `npm run acceptance:pdf` in `source/`.
- Core verification commands are `npm test`, `npm run test:integration`, and `npm run smoke`.
- Last updated: 2026-09-28.

## Automated Evidence

- `npm test` runs the API regression suite, including billing, payments, error handling, report export, CORS, and the HTTP authorization regression for AT-10.
- `npm run test:integration` runs the PostgreSQL-backed acceptance and workflow tests for billing, payments, collections, receivables, reports, backup/restore, dashboard aggregation, service control, and attachment validation.
- `npm run smoke` exercises the API over HTTP and records reproducible operational evidence such as permission failures, report exports, and end-to-end seed assertions.

## Mandatory Acceptance Tests

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| AT-01 | Exact payment | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-02 | Partial payment | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-03 | Advance payment | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-04 | Oldest-first arrears | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-05 | Duplicate GCash reference | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-06 | Payment reversal | Passed | `source/apps/api/tests/integration.payments.test.ts` |
| AT-07 | Collector balanced remittance | Passed | `source/apps/api/tests/integration.collections.test.ts` |
| AT-08 | Collector shortage | Passed | `source/apps/api/tests/integration.collections.test.ts` |
| AT-09 | Concurrent users on two or three PCs | Pending | Requires live multi-PC or parallel-client execution evidence for the final deployment setup |
| AT-10 | Cashier attempts an admin-only operation | Passed | `source/apps/api/tests/authorization.http.test.ts` and `npm run smoke` |
| AT-11 | Duplicate billing generation | Passed | `source/apps/api/tests/integration.payments.test.ts` and `source/apps/api/tests/billing.test.ts` |
| AT-12 | Backup and restore | Passed | `source/apps/api/tests/integration.backup.test.ts` |

## Desktop And Report Evidence

- `npm run smoke` verifies report export responses for PDF, XLSX, and CSV, including file-signature checks for `%PDF` and `PK`.
- The desktop application exposes native print, save, and file-picker operations through the typed preload bridge in `source/apps/desktop/preload.js`.
- Additional UI screenshots and sample report files remain required for the final package in `tests/screenshots/` and `reports-samples/`.

## Defect And Regression Evidence

- The project bug log with symptom, root cause, fix, and regression evidence is maintained in `LAB4-COMPLIANCE-CHECKLIST.md`.
- Recent regression evidence includes money-type fixes, rate-limit error handling, migration reset safety, seed idempotency, and reconnection allocation behavior.

## Remaining Open Items

- AT-09 still needs explicit concurrency validation against the deployed three-PC setup.
- The final submission package still benefits from additional screenshots and sample exported reports.

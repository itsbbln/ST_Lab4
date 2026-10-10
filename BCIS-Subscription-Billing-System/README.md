# BCIS Subscription Billing and Collection System

A three-office LAN-based billing and collection management system for Bukidnon Cable and Internet Services (BCIS). This project follows the laboratory requirement for an Electron desktop client, a Fastify API, PostgreSQL data storage, and a financial workflow with auditing, reporting, and backup/restore support.

## Overview

This system is designed to manage:

- Internet, Cable, and Combo subscriptions
- Monthly billing cycles and invoice generation
- Subscriber ledger and account balances
- Cash and GCash collection workflows
- Collector accountability and remittance reconciliation
- Overdue receivables and service suspension/reconnection handling
- Reports, exports, and operational dashboards
- Role-based access control and audit logging

## Architecture

The application is built as a multi-workspace monorepo:

- Electron desktop clients for the office terminals
- React renderer for the user interface
- Fastify API as the single access layer
- PostgreSQL + Drizzle ORM for persistent storage
- Zod validation and strict TypeScript for safe inputs and financial rules
- Shared package for common domain logic and money handling

## Core Features

### Subscriber and service management
- Subscriber profiles with account numbers, contacts, and addresses
- Multiple service accounts per subscriber
- Service plans for Internet, Cable, and Combo packages
- Subscriber statuses and service event history

### Billing and accounting
- Monthly invoice generation for active accounts
- Invoice states for unpaid, partial, paid, overdue, and voided transactions
- Ledger tracking with running balances
- Statement-of-account generation and arrears visibility

### Payment processing
- Cash, GCash, bank transfer, cheque, and other payment types
- Exact, partial, and advance payment handling
- Allocation logic and payment reversal without data loss
- Receipt generation and validation

### Collections and receivables
- Collection areas, route assignments, and collector batches
- Remittance summaries and shortage/overage enforcement
- Aging buckets and overdue monitoring
- Suspension and reconnection workflows

### Reporting and security
- PDF, XLSX, and CSV exports
- Dashboard summaries for billing and collection performance
- Role-based permissions and audit trails
- Backup, verification, and restore support

## Tech Stack

- Node.js
- TypeScript
- Electron
- React
- Fastify
- PostgreSQL
- Drizzle ORM
- Zod
- Vitest
- pdfmake
- ExcelJS

## Repository Structure

```text
BCIS-Subscription-Billing-System/
├── README.md
├── CLAUDE.md
├── LAB4-COMPLIANCE-CHECKLIST.md
├── source/
│   ├── apps/
│   │   ├── api/
│   │   └── desktop/
│   ├── packages/
│   │   └── shared/
│   ├── scripts/
│   ├── package.json
│   └── tsconfig.base.json
├── database/
│   ├── migrations/
│   └── seeds/
├── docs/
│   ├── api-spec.md
│   ├── deployment-guide.md
│   ├── erd.md
│   ├── technical-documentation.md
│   └── user-manual.md
├── tests/
│   ├── acceptance-test-report.md
│   └── screenshots/
├── reports-samples/
├── release/
└── ...
```

## Prerequisites

Before running the project, make sure you have:

- Node.js 20+
- npm
- PostgreSQL 17
- A working `.env` configuration for the API and database

## Getting Started

From the `source` folder:

```bash
npm install
cp .env.example .env
npm run db:reset
npm run seed:demo
```

### Start the application

```bash
npm run dev:api
npm run dev:renderer
npm run dev:electron
```

Or start everything together:

```bash
npm run dev
```

## Verification

Run the test suite:

```bash
npm test
npm run test:integration
npm run verify
```

## Documentation

- [docs/technical-documentation.md](docs/technical-documentation.md)
- [docs/user-manual.md](docs/user-manual.md)
- [docs/api-spec.md](docs/api-spec.md)
- [docs/erd.md](docs/erd.md)
- [docs/deployment-guide.md](docs/deployment-guide.md)
- [LAB4-COMPLIANCE-CHECKLIST.md](LAB4-COMPLIANCE-CHECKLIST.md)

## Notes

This repository is intended as the implementation and documentation package for the BCIS laboratory activity. It demonstrates a realistic billing and collection workflow with financial integrity, operational controls, and process visibility expected from a multi-office service provider environment.

Optional checks:

```bash
npm run typecheck
npm run lint
npm run smoke
```

## Demo dataset

The project includes a deterministic demo dataset created through the seed script. It is designed to satisfy the minimum conditions in the lab brief, including:

- 5+ users
- 7 plans (3 Internet, 2 Cable, 2 Combo)
- 50 subscribers
- 60+ service accounts
- multiple billing periods
- mixed payment methods
- overdue receivables across several aging buckets
- collection batches and remittance scenarios

This synthetic dataset ensures the app can be exercised realistically without using production data.

## Implementation status

This project addresses the lab’s core requirements and implements the financial engine and backend workflows extensively. The API and database layer are substantially complete and validated. The desktop renderer remains a thin UI shell and continues to be the area where the remaining workflow polishing and final presentation work are focused.

## Compliance and lab alignment

This repository aligns with the PDF lab requirements for:

- three-office LAN architecture
- Electron + Fastify + PostgreSQL architecture
- role-based authorization and audit logging
- monthly billing generation
- subscriber-ledger accounting
- payment allocation, reversal, and receipt handling
- receivables aging and collection accountability
- reporting and export capability
- backup, integrity, and restore support

The project also includes a compliance checklist and technical documentation in the `docs/` and project root directories to support the laboratory submission.

## Documentation

Additional documentation is available in:

- `docs/technical-documentation.md`
- `docs/user-manual.md`
- `docs/api-spec.md`
- `docs/erd.md`
- `docs/deployment-guide.md`
- `LAB4-COMPLIANCE-CHECKLIST.md`

## Notes

This repository is intended to serve as the source for the BCIS laboratory project and its submission package. It reflects the architecture and financial domain requirements described in the assignment PDF and is organized to support both development and evidence-based compliance review.

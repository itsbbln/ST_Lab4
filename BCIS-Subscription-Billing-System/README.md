# BCIS Subscription Billing and Collection System
# ST-LabAct4

This repository implements the BCIS laboratory project for a three-office LAN-based billing and collection system for Bukidnon Cable and Internet Services (BCIS). The project is designed around a professional Windows desktop client, a Fastify API, and a PostgreSQL-backed transactional data layer.

## Project overview

The lab activity requires a desktop application that supports three simultaneous office PCs connected to a local area network. The system must handle:

- Internet, Cable, and Combo subscriptions
- Monthly billing generation
- Subscriber ledger tracking
- Cash and GCash collection
- Collector accountability and remittance reconciliation
- Overdue receivables and service suspension/reconnection workflows
- Monthly, weekly, and period-based reporting
- Audit logging and backup/restore operations

The final design follows the required architecture:

- Electron desktop clients
- React renderer for the user interface
- Fastify API as the single access layer
- PostgreSQL + Drizzle ORM as the data store
- Zod validation and strict TypeScript across the app

## Business context

The system models the billing operations of a cable and internet service provider. Each subscriber may hold one or more service accounts, and each service may be based on a plan type such as:

- Internet
- Cable
- Combo

The system supports monthly billing cycles, automatic invoice generation, payment allocation, receivables aging, and financial reconciliation. It is designed for operational use in a multi-office environment where billing staff, cashiers, auditors, and collection supervisors each work with different permissions and responsibilities.

## Functional scope

### 1. Subscriber and service management

- Create and maintain subscribers with account numbers, contact details, and addresses
- Support multiple service addresses per subscriber
- Track subscriber status (active, inactive, terminated, archived)
- Maintain service accounts tied to plan, billing dates, install address, and service status
- Support plan changes, suspension, and reconnection flows

### 2. Billing and ledger engine

- Generate monthly bills for each active service account
- Maintain invoice statuses such as DRAFT, UNPAID, PARTIALLY_PAID, PAID, OVERDUE, VOID, and CREDITED
- Store line-items for subscription, installation, reconnection, discounts, adjustments, and penalties
- Prevent duplicate billing generation
- Maintain reproducible running balances through a subscriber ledger
- Support opening balances, carry-over balances, and statement-of-account generation

### 3. Payment processing

- Accept payments via Cash, GCash, Bank Transfer, Cheque, and Other methods
- Support exact, partial, and advance payment scenarios
- Allocate payment amounts in a defined order
- Support manual override of allocation where necessary
- Reverse incorrect or invalid payments without deleting history
- Reserve and validate receipt numbers

### 4. GCash verification workflow

- Accept payment proof submissions with reference numbers, sender details, amount, and attachments
- Prevent duplicate reference submissions
- Require verification/rejection steps before posting funds
- Retain audit evidence for every verification decision

### 5. Collection and remittance

- Organize subscribers by collection area and route
- Assign collectors and batch accounts for collection cycles
- Produce route sheets and remittance summaries
- Track collected vs expected amounts
- Enforce shortage and overage checks
- Prevent batch closure without explicit discrepancy acknowledgement

### 6. Receivables and service control

- Monitor overdue balances and aging buckets
- Track receivables by collector, area, plan, service type, and delinquency age
- Identify suspension candidates
- Manage suspension and reconnection records
- Maintain service event history for every operational change

### 7. Reporting and export

- Produce billing, payment, collection, performance, and aging reports
- Export reports in PDF, XLSX, and CSV formats
- Support subscriber master lists, ledger statements, and collector summaries
- Provide dashboard-style operational reporting for financial KPIs

### 8. Security, audit, and backup

- Enforce role-based access control (RBAC)
- Validate permissions through API-level guards
- Hash passwords with scrypt-based protection
- Use transactional database operations for financial changes
- Log actor, action, timestamp, reason, and metadata for every financial mutation
- Support backup creation, verification, and restore workflows

## Required architecture

The project is structured as a multi-workspace monorepo under `source/`.

### Application architecture

- Desktop shell: Electron
- UI renderer: React + TypeScript + Vite
- API layer: Fastify + TypeScript
- Database: PostgreSQL
- ORM: Drizzle
- Shared validation and money model: shared package

This arrangement keeps the renderer thin and prevents direct database access from the desktop client. All business logic is enforced on the API server before writes reach the database.

## Roles and permissions

The lab requires multiple office roles with different responsibilities. The project models role-based permissions for operations such as:

- user management
- subscriber management
- billing generation
- payment posting and reversal
- collection reconciliation
- report access and export
- backup and restore operations

The permissions model is backed by database tables so access rules are enforced consistently and auditable.

## Tech stack

- Node.js and npm workspaces
- TypeScript
- Fastify 5
- Electron
- React 19
- PostgreSQL 17
- Drizzle ORM
- Zod validation
- Vitest for unit and integration testing
- pdfmake and ExcelJS for report generation
- Pino for structured logging

## Repository structure

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

Before running the project, make sure the following are available:

- Node.js 20+
- npm
- PostgreSQL 17
- A local `.env` configuration for database and API settings

## Local setup

1. Open a terminal in the `source/` directory.
2. Install dependencies:

```bash
npm install
```

3. Create or update the environment file. The project includes a `.env.example` file as a reference.

4. Prepare the database schema:

```bash
npm run db:reset
```

5. Seed the demo dataset required by the laboratory activity:

```bash
npm run seed:demo
```

## Run the system

### Start the API

```bash
npm run dev:api
```

### Start the renderer

```bash
npm run dev:renderer
```

### Launch Electron desktop shell

```bash
npm run dev:electron
```

### Run the project in one command

```bash
npm run dev
```

## Verification and testing

The project includes both unit and integration tests to validate the accounting and billing behavior.

Run the main test suite:

```bash
npm test
```

Run the integration suite:

```bash
npm run test:integration
```

Run the full validation set:

```bash
npm run verify
```

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

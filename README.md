# ST-LabAct4

This workspace contains the BCIS laboratory project and supporting materials for the Subscription Billing and Collection System.

## Overview

The main project, [BCIS-Subscription-Billing-System](BCIS-Subscription-Billing-System), is a three-office LAN-based billing and collection system for Bukidnon Cable and Internet Services (BCIS). It implements a desktop workflow built with Electron, React, Fastify, PostgreSQL, and Drizzle.

## Included in this workspace

- [BCIS-Subscription-Billing-System](BCIS-Subscription-Billing-System) — main application source, database, docs, and validation assets
- [lab_activity_extracted.txt](lab_activity_extracted.txt) — extracted activity notes
- [BCIS_Subscription_Billing_and_Collection_Laboratory_Activity.pdf](BCIS_Subscription_Billing_and_Collection_Laboratory_Activity.pdf) — original lab PDF

## Main project features

- Internet, Cable, and Combo subscription handling
- Monthly billing and invoice generation
- Subscriber ledger and statement tracking
- Cash and GCash payment processing
- Collection area, collector, and remittance workflows
- Overdue receivables and service suspension/reconnection tracking
- Role-based access control and auditing
- Backup, restore, and integrity checks
- PDF, XLSX, and CSV reporting

## Project structure

```text
ST-LabAct4/
├── README.md
├── lab_activity_extracted.txt
├── BCIS_Subscription_Billing_and_Collection_Laboratory_Activity.pdf
├── BCIS-Subscription-Billing-System/
│   ├── README.md
│   ├── CLAUDE.md
│   ├── LAB4-COMPLIANCE-CHECKLIST.md
│   ├── source/
│   ├── database/
│   ├── docs/
│   ├── tests/
│   ├── reports-samples/
│   └── release/
└── ...
```

## Quick start

To run the actual system:

```bash
cd BCIS-Subscription-Billing-System/source
npm install
npm run db:reset
npm run seed:demo
npm run dev
```

Or run the services separately:

```bash
npm run dev:api
npm run dev:renderer
npm run dev:electron
```

## Validation

```bash
npm test
npm run test:integration
npm run verify
```

## Documentation

See the main project documentation in:

- [BCIS-Subscription-Billing-System/README.md](BCIS-Subscription-Billing-System/README.md)
- [BCIS-Subscription-Billing-System/docs/technical-documentation.md](BCIS-Subscription-Billing-System/docs/technical-documentation.md)
- [BCIS-Subscription-Billing-System/docs/user-manual.md](BCIS-Subscription-Billing-System/docs/user-manual.md)
- [BCIS-Subscription-Billing-System/docs/api-spec.md](BCIS-Subscription-Billing-System/docs/api-spec.md)
- [BCIS-Subscription-Billing-System/LAB4-COMPLIANCE-CHECKLIST.md](BCIS-Subscription-Billing-System/LAB4-COMPLIANCE-CHECKLIST.md)

## Notes

This workspace is organized as a lab submission package and includes both the implementation and supporting documentation for the BCIS billing and collection system.

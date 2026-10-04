# BCIS Subscription Billing and Collection System

This repository contains the BCIS laboratory project for a three-office desktop billing workflow. The solution includes an Electron desktop shell, a Fastify API, a PostgreSQL-backed Drizzle data layer, and a React renderer for the office client experience.

## Project structure

- `source/` – monorepo application source for the API, desktop client, and shared libraries.
- `database/migrations/` – Drizzle SQL migrations.
- `database/seeds/` – synthetic demo data seeding scripts.
- `docs/` – technical and user documentation.
- `tests/` – acceptance evidence and screenshots.
- `reports-samples/` – sample export artifacts.
- `release/` – packaging and release notes.

## Quick start

1. Open a terminal in the `source/` directory.
2. Install dependencies:
   - `npm install`
3. Start the API:
   - `npm run dev:api`
4. Start the renderer:
   - `npm run dev:renderer`
5. Launch Electron:
   - `npm run dev:electron`

## Validation

Run the project verification suite:

- `npm test`
- `npm run typecheck`

The API includes database-backed billing, payments, ledger posting, and authorization checks with a PostgreSQL runtime.

## Demo data

Synthetic seed data can be generated with:

- `npm run seed:demo`

This runs the demo seed script under `database/seeds/seed-demo.ts`.

## Notes

This repository is organized for compliance with the lab requirements and acts as the source for the submission package.

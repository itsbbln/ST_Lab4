# BCIS project instructions

## Purpose

This project implements the BCIS subscription billing and collection system for a three-office LAN deployment. It is intentionally structured around a Fastify API, a PostgreSQL-backed data layer, and an Electron + React desktop client.

## Quality bar

- Keep financial logic in the API layer, not in the renderer.
- Use integer centavos for money and never floating-point arithmetic.
- Prefer transactional updates for invoice generation, payments, reversals, and remittances.
- Validate all external input with Zod schemas.
- Preserve audit history for all financial and security actions.
- Never expose secrets in code or logs.

## Working rules

- Prefer small, verifiable changes with tests.
- Keep migrations and seeds reproducible from a clean database.
- Keep documentation, screenshots, and report artifacts in the repository for submission evidence.
- Favor evidence-based validation over assumptions.

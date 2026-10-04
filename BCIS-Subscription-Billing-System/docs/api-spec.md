# API specification

## Authentication

- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`

## Directory and account management

- `GET /plans`
- `POST /plans`
- `GET /subscribers`
- `POST /subscribers`
- `POST /service-accounts`
- `POST /collection-areas`

## Billing

- `GET /invoices`
- `POST /billing/generate`
- `GET /ledger/:serviceAccountId`

## Payments and collections

- `POST /payments/preview`
- `POST /payments`
- `POST /payments/reverse`
- `GET /payments`
- `GET /gcash`
- `POST /gcash`
- `POST /gcash/verify`
- `GET /receivables/aging`

## Utilities

- `GET /health`
- `GET /dashboard`
- `GET /audit-logs`

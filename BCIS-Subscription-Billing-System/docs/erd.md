# ERD overview

## Core entities

- users
- roles
- permissions
- role_permissions
- user_roles
- subscribers
- subscriber_addresses
- collection_areas
- collection_routes
- collectors
- service_types
- service_plans
- service_accounts
- invoices
- invoice_items
- payments
- payment_allocations
- payment_proofs
- receipts
- payment_reversals
- ledger_entries
- billing_cycles
- collection_batches
- batch_accounts
- remittances
- audit_logs

## Relationships

The model follows a relational pattern where subscribers own one or more service accounts, service accounts are billed through invoice rows, and payments are allocated to invoice balances while preserving a ledger trail for each account.

# Technical documentation

## Overview

The BCIS project is a multi-workspace monorepo that implements a three-office LAN billing system with:

- Electron desktop clients
- React UI renderer
- Fastify API
- PostgreSQL + Drizzle data layer
- Shared validation and monetary helper library

## Application architecture

### Desktop client

The renderer is kept thin and interacts with the API through HTTP. It does not open the database directly.

### API service

The Fastify API exposes routes for authentication, directory management, billing, payments, collections, reports, and receivables. Authorization is enforced at the route layer via permission checks and audited under the `audit_logs` model.

### Data layer

The schema layer models directory, security, billing, payments, ledgers, collections, operations, and systems data. Money is stored as integer centavos and all critical financial operations are transactional.

## Security model

- Passwords are hashed with scrypt and user-specific salts.
- Sessions expire on the server.
- Permissions are assigned via role mappings.
- Authorization is enforced through API `preHandler` guards.

## Backup and restore

The platform is designed to support backup processing through the configured backup directory and the migration system. The submitted repo includes the expected structure and configuration hooks for operational backup and restore workflows.

## Deployment notes

Use the workspace root and follow the standard API / renderer startup commands with the provided environment file. The runtime environment is configured via `.env` and the project expects a PostgreSQL 17 service.

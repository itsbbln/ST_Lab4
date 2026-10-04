# Deployment guide

## Prerequisites

- PostgreSQL 17
- Node.js 20+
- npm workspaces enabled
- Local `.env` file copied from `.env.example`

## Database setup

1. Create the target database.
2. Set `DATABASE_URL` in `.env`.
3. Run the migration script:
   - `npm run db:migrate -w @bcis/api`

## App startup

From the `source/` folder:

- `npm install`
- `npm run dev:api`
- `npm run dev:renderer`
- `npm run dev:electron`

## Production packaging

Use the Electron packaging workflow to produce the Windows desktop installer in the `release/` folder.

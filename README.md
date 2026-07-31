# MediCRM

A CRM for a pharmacy/Ayurvedic medicine business: leads are called, converted into customers and orders, and tracked through renewals and follow-ups. Two roles — **admin** sees everything, **caller** sees only their own work.

React + TypeScript on the front, Express + Prisma + PostgreSQL behind it, in a single npm workspace.

## Requirements

- Node 24+
- PostgreSQL 18

## Setup

```bash
npm install
```

Create `server/.env` from the example and point it at your database:

```bash
cp server/.env.example server/.env
```

`DATABASE_URL` is the only place a connection string is written down. The test suites, the browser suite and the test-database builder all derive theirs from it by swapping in the database name, so there is nothing else to keep in sync.

Then create the schema and load the sample data:

```bash
npm run db:migrate && npm run db:seed
```

## Running

```bash
npm run dev
```

Vite on `:5173`, the API on `:3001`, proxied so the browser only ever talks to one origin.

Seeded logins — password `admin123` for admins, `caller123` for callers:

| | role | sees |
|---|---|---|
| `aarav.sharma@medicrm.in` | admin | everything |
| `sneha.iyer@medicrm.in` | caller | only their own leads, orders, renewals |
| `kavya.reddy@medicrm.in` | caller | nothing — seeded **inactive**, so login is refused |

## Testing

```bash
npm test          # typecheck, build, then 120 backend tests
npm run test:e2e  # 40 browser tests through the real UI
```

Both build `crm_test` from scratch first — dropped, migrated and reseeded — so a failure never depends on what ran before it. Your development database is never touched.

The browser suite starts its own API and Vite on different ports (`:3002` / `:5174`), so you can leave `npm run dev` running while it executes.

CI runs both on every push.

## How it is put together

```
client/   React 19, React Router, Tailwind, Vite
server/   Express 5, Prisma 7, PostgreSQL
e2e/      Playwright specs driving the real UI
```

**The database holds no logic.** No triggers, no stored procedures, no row-level security, no generated columns — 20 Prisma models and nothing else. Every rule lives in TypeScript where it can be read, tested and stepped through. The test-database builder asserts the schema contains zero `plpgsql` functions on every run, so this does not quietly erode.

**Authorization is enforced at the data layer, not in routes.** `server/src/db/scoped.ts` is a Prisma Client extension that appends an ownership predicate to every query for a scoped model. It is fail-closed: a model nobody has classified throws rather than being served unscoped, so adding a table without thinking about who may see it breaks loudly instead of leaking. A route cannot forget to filter, because filtering is not the route's job.

**Dates are IST, deliberately.** Nearly every figure a user sees — "due today", "overdue", this week's calls — is an Asia/Kolkata calendar date, not a UTC one. Both suites pin the timezone, and CI does too; without that, tests pass or fail depending on the time of day they run.

**Money is `Decimal`, never `number`.** Order lines and discounts use Prisma's `Decimal` end to end.

## Scripts

| | |
|---|---|
| `npm run dev` | client and API together |
| `npm run build` | build both |
| `npm run typecheck` | both workspaces |
| `npm test` | typecheck, build, backend suite |
| `npm run test:e2e` | browser suite |
| `npm run db:migrate` | apply migrations |
| `npm run db:seed` | load sample data |
| `npm -w server run db:studio` | browse the database |

# Acme CRM

A modern, full-stack CRM built from scratch, using Bitrix24 as a functional reference and redesigned for a much simpler experience.
Leads, deals with pipelines and Kanban, contacts, companies, products and line items, activities and reminders, a unified timeline,
custom fields (including "required from stage"), role-based permissions with teams, automation rules, dashboard and reports.

> **Continuing this project?** Start with [docs/HANDOFF.md](docs/HANDOFF.md) and [CLAUDE.md](CLAUDE.md).
> A ready-to-paste prompt for a new AI agent is in [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md).

## Stack

| Layer | Choice |
|---|---|
| Runtime | **Node.js 26 LTS** (runs the TypeScript sources directly — no build step for the API) |
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4, Lucide, TanStack Query, React Router, dnd-kit, Radix primitives, Recharts |
| Backend | Fastify 5, zod 4 validation, plain parameterised SQL via `pg` |
| Database | PostgreSQL 16+ (hand-written SQL migrations, `pg_trgm` search) |
| Jobs | Built-in Postgres job table + outbox (automation delays, reminders, purge) |
| Tests | Vitest (API against a real database) and Playwright (desktop, tablet, phone) |

All dependencies are pinned to exact, current stable versions; `npm audit` reports 0 vulnerabilities (checked in CI).

## Getting started

Requirements: Node.js 26 LTS (`.nvmrc`) and PostgreSQL 16+ (or Docker).

```bash
cp .env.example .env
docker compose up -d db        # or use your own PostgreSQL with databases crm_dev and crm_test
npm ci
npm run db:migrate
npm run db:seed                # optional demo data: demo@example.com / demo12345
npm run dev                    # API on :3000 (with background worker) + web on :5173
```

Open http://localhost:5173 and sign in with the demo account, or create a new workspace at `/signup`.

### Production

```bash
npm ci && npm run build
NODE_ENV=production DATABASE_URL=postgres://… APP_URL=https://crm.example.com npm start
```

`npm start` applies migrations, serves the API under `/api/v1` and the built web app on the same port, and runs background jobs
in-process. To run jobs separately, set `INLINE_WORKER=false` and start `npm run worker -w @crm/api`.
Session cookies are `Secure` in production, so serve it over HTTPS.

## Checks

```bash
npm run typecheck
npm run lint
npm test                       # unit + API integration tests (uses TEST_DATABASE_URL)
npm run build && npm run e2e   # Playwright; set PW_CHROMIUM_PATH to use a preinstalled Chromium
```

## Project layout

```
apps/api       Fastify API, SQL migrations, automation engine, seed, tests
apps/web       React single-page app
packages/shared  zod schemas, enums, money math shared by API and web
e2e            Playwright end-to-end tests
docs           Bitrix24 research, UX redesign, architecture, schema, plan
```

## Research & plan

| Document | Contents |
|---|---|
| [docs/BITRIX24_ANALYSIS.md](docs/BITRIX24_ANALYSIS.md) | Module-by-module breakdown of the reference CRM |
| [docs/CRM_FEATURES.md](docs/CRM_FEATURES.md) | Feature inventory and scope |
| [docs/CRM_WORKFLOWS.md](docs/CRM_WORKFLOWS.md) | Workflows tested in Bitrix24 and the business rules derived |
| [docs/CRM_UX_REDESIGN.md](docs/CRM_UX_REDESIGN.md) | UX problems found and the redesign |
| [docs/CRM_ARCHITECTURE.md](docs/CRM_ARCHITECTURE.md) | Architecture (see "As built") |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | PostgreSQL schema and rules |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Milestones |

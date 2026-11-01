# Technical Architecture

> **As built (Nov 2026).** The plan below was followed with these deliberate changes, made to keep the dependency surface small
> after a security audit of the latest package versions:
>
> | Planned | Built | Why |
> |---|---|---|
> | Node 22 | **Node 26 LTS**, TypeScript run natively (type stripping) | Current Active LTS; no build step for the API |
> | Drizzle ORM + drizzle-kit | **Plain parameterised SQL** (`pg` + a 60-line tagged-template builder) and hand-written SQL migrations | drizzle-kit pulled a vulnerable esbuild; raw SQL also suits reports, scope filters and trigram search |
> | pg-boss | **Own `jobs` + `outbox_events` tables** with `FOR UPDATE SKIP LOCKED` | Fewer dependencies; easy time-travel in tests |
> | fastify-type-provider-zod | Small `parse()` helper calling zod directly | One less plugin; identical error shape |
> | @fastify/static | Tiny built-in static handler with SPA fallback | @fastify/static pulled vulnerable glob/minimatch |
> | TanStack Table, react-hook-form | Own `DataTable` and `useForm` | Server-side sorting/paging makes them unnecessary |
> | TypeScript 7 | **TypeScript 6.0** | typescript-eslint does not support TS 7 yet |
>
> "Required from stage" fields are required from the earliest chosen stage onward (including Won), never when a record is lost.


## 1. Summary

| Layer | Choice | Why |
|---|---|---|
| Repo | **npm workspaces monorepo** (`apps/web`, `apps/api`, `packages/shared`) | One install, one CI, shared types |
| Frontend | **React 19 + TypeScript + Vite + Tailwind CSS v4 + Lucide** | As requested; fast DX |
| Routing / data | React Router (data routers) + **TanStack Query** | Caching, optimistic updates (Kanban), retries |
| Tables | **TanStack Table** (headless) | Sorting, column visibility, selection with our own styling |
| Drag & drop | **dnd-kit** | Accessible (keyboard) Kanban |
| Forms | **react-hook-form + zod** (schemas from `packages/shared`) | Same validation client & server |
| UI primitives | **Radix UI** primitives (dialog, popover, dropdown, tooltip) styled with Tailwind | Accessibility without a heavy component kit |
| Charts | **Recharts** | Simple dashboard charts |
| Backend | **Node.js 22 + Fastify 5 + TypeScript** | Fast, plugin architecture, first-class zod type provider |
| ORM / SQL | **Drizzle ORM** + drizzle-kit migrations | Typed SQL, no runtime magic, easy raw SQL for reports |
| Database | **PostgreSQL 16** (+ `pg_trgm`, `citext`) | As requested; JSONB for custom fields, trigram search |
| Background jobs | **pg-boss** (queue in Postgres) | Automation delays, reminders, purges — no Redis needed |
| Auth | Own session auth: argon2id hashes, opaque session IDs in **httpOnly SameSite=Lax cookies**, sessions table | Simple, secure, revocable; no third-party dependency |
| Testing | **Vitest** (unit + API integration on a real Postgres), **Playwright** (e2e, desktop/tablet/mobile viewports) | Matches the "test everything in a real browser" requirement |
| Lint/format | ESLint (typescript-eslint) + Prettier | Consistency |
| CI | GitHub Actions: typecheck → unit → API tests (Postgres service) → build → e2e | Green-before-merge |
| Runtime | Docker images; `docker compose` for local Postgres | Portable deploy |

### Alternatives considered

- **NestJS** instead of Fastify: more structure out of the box, but heavier decorators/DI and
  duplicated DTO classes vs. shared zod schemas. Fastify + feature folders gives the same
  modularity with less code. (NestJS can run on Fastify if the team prefers it later.)
- **Prisma** instead of Drizzle: great DX, but a heavier runtime/engine and awkward JSONB/raw
  report queries. Drizzle keeps SQL visible, which suits reporting and permission filters.
- **Next.js** full-stack: SSR is not needed for an authenticated CRM SPA; a separate API keeps the
  public REST API and future mobile apps first-class.

## 2. System overview

```
┌──────────────── Browser (SPA) ─────────────────┐
│ React + TanStack Query + Router                │
│  ├─ features/{deals,leads,contacts,...}        │
│  ├─ components/ui (design system)              │
│  └─ api client (typed from packages/shared)    │
└───────────────▲────────────────────────────────┘
                │ HTTPS JSON  /api/v1/*   (cookie session)
┌───────────────┴────────────────────────────────┐
│ Fastify API                                     │
│  plugins: auth · workspace · rbac · errors ·   │
│           rate-limit · request-id · logging    │
│  modules: auth users teams roles pipelines     │
│           leads deals contacts companies       │
│           products activities notes timeline   │
│           fields automation reports search     │
│           notifications recycle-bin audit      │
│  domain events → outbox table (same txn)       │
└───────┬───────────────────────────┬────────────┘
        │ SQL (Drizzle)             │ pg-boss jobs
┌───────▼───────────────┐  ┌────────▼───────────┐
│ PostgreSQL 16          │  │ Worker process      │
│ tables + outbox + jobs │◄─┤ automation engine   │
└────────────────────────┘  │ reminders, purges   │
                            └─────────────────────┘
```

The API and worker are the same codebase with two entry points (`server.ts`, `worker.ts`).

## 3. Repository layout

```
crm_template/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ server.ts, worker.ts, app.ts
│  │  │  ├─ db/ (schema/*.ts, migrations/, seed.ts, client.ts)
│  │  │  ├─ plugins/ (auth.ts, rbac.ts, errors.ts, workspace.ts)
│  │  │  ├─ modules/<feature>/ (routes.ts, service.ts, repo.ts, *.test.ts)
│  │  │  ├─ domain/ (events.ts, audit.ts, money.ts, permissions.ts)
│  │  │  └─ automation/ (engine.ts, actions/*.ts, triggers.ts)
│  │  └─ test/ (helpers: test db, factories)
│  └─ web/
│     ├─ src/
│     │  ├─ app/ (router, providers, layout/Sidebar, CommandPalette)
│     │  ├─ components/ui/ (Button, DataTable, Kanban, StageBar, Drawer…)
│     │  ├─ features/<feature>/ (pages, components, hooks, api.ts)
│     │  ├─ lib/ (apiClient, format, permissions)
│     │  └─ styles/ (tailwind.css with @theme tokens)
│     └─ e2e/ (Playwright specs)
├─ packages/shared/ (zod schemas, enums, permission keys, money math, types)
├─ docs/ (this research + ADRs)
├─ docker-compose.yml (postgres)
└─ .github/workflows/ci.yml
```

## 4. Backend design

### 4.1 Request pipeline
1. `request-id` + structured logging (pino).
2. **Session**: cookie → `sessions` row → `user`, `workspace`, `role`.
3. **Validation**: zod schemas on params/query/body (from `packages/shared`).
4. **RBAC**: route declares `{ entity, action }`; plugin checks the role grants; services apply
   **scope filters** (see 4.3) to queries and check record-level access for mutations.
5. **Service** runs in a DB transaction: writes rows, writes **audit events**, writes
   **outbox events** (for automation/notifications).
6. Error handler maps to a single error shape.

### 4.2 API conventions
- REST under `/api/v1`. Resources: `/leads`, `/deals`, `/contacts`, `/companies`, `/products`,
  `/activities`, `/notes`, `/pipelines`, `/pipelines/:id/stages`, `/fields`, `/automation-rules`,
  `/users`, `/teams`, `/roles`, `/reports/:key`, `/search`, `/notifications`, `/recycle-bin`.
- Commands as sub-resources: `POST /leads/:id/convert`, `POST /deals/:id/move`
  (`{stageId, fields?}`), `POST /deals/:id/close` (`{outcome: won|lost, lostReasonId?}`),
  `POST /deals/:id/reopen`, `POST /:entity/:id/restore`, `POST /contacts/merge`,
  `GET /duplicates?email=&phone=&name=`.
- **List query**: `?q=&page=1&pageSize=25&sort=-amount,title&filter[ownerId]=me&filter[stageId]=..&filter[createdAt][gte]=..&view=<savedViewId>`.
  Response: `{ data: [...], page, pageSize, total, aggregates?: { amountSum } }`.
- Errors: `{ error: { code: "VALIDATION_FAILED", message, fields: { email: "Invalid email" } } }`
  with HTTP 400/401/403/404/409/422/429/500.
- Optimistic concurrency: records carry `version`; `PATCH` with `If-Match` style `version` field →
  409 on conflict.
- IDs: `bigint identity` internally, exposed as strings (safe for JS).

### 4.3 Authorization model
- **Role grants**: `(role, entity, action) → scope` where action ∈ `view|create|edit|delete|export|import`
  and scope ∈ `none|own|team|all`.
- **Scope filter** for lists/reports: `own → owner_id = :me`; `team → owner_id IN (members of my teams)`;
  `all → true`; plus `OR visibility = 'shared'` for *view* when the grant is `own|team`.
- **Record check** for mutations uses the same predicate on the loaded row.
- Workspace **Admin** role bypasses grants (except cross-workspace — never).
- Settings endpoints require `settings.manage`.
- Later: per-pipeline grants, "move to stage", field-level visibility.

### 4.4 Validation & custom fields
- Base fields: static zod schemas.
- Custom fields: definitions loaded per workspace (cached), compiled to a zod object for
  `custom` JSON. Required checks:
  - `required = always` → enforced on create/update;
  - `required_from_stage_ids` → enforced on stage change (`/move`, `/close`, `PATCH stageId`).
- The UI calls `/deals/:id/move` and, on `422 REQUIRED_FIELDS`, renders the mini-form with the
  returned field list (Bitrix24 pattern, but enforced server-side).

### 4.5 Audit & timeline
- `audit_events(entity_type, entity_id, action, actor_id, changes jsonb, created_at)` written by
  services with a computed diff (`{field: [old, new]}`) — powers the *History* tab.
- Timeline API merges: notes, activities (by link), audit events of interest (created, stage
  changed, converted, won/lost, owner changed), automation messages. Cursor-paginated by time.

### 4.6 Automation engine
1. Services emit domain events into `outbox` in the same transaction
   (`deal.created`, `deal.stage_entered`, `deal.updated`, `lead.created`, `activity.overdue`…).
2. Worker polls outbox → finds matching enabled rules (pipeline + stage + trigger + conditions).
3. For each rule: schedule a pg-boss job with `startAfter = now + delay` (business-hours aware later).
4. Job re-checks conditions (e.g. "still in this stage"), executes the action, records
   `automation_runs` (status, error, duration) and writes a timeline entry.
5. Loop guard: events produced by automation carry `depth`; stop at depth 5.
Actions v1: create activity, notify user, add note, update field, change owner (fixed or
round-robin in team), move stage, webhook (v1.1).

### 4.7 Search & duplicates
- `pg_trgm` GIN indexes on names, company names, emails; phones stored normalised (digits, E.164).
- `/search?q=` returns top hits per entity type (Cmd-K).
- Duplicate check: exact match on normalised email/phone across leads/contacts/companies;
  trigram similarity ≥ 0.6 on person/company names as "possible".

### 4.8 Money & numbers
- `numeric(18,2)` in DB, serialized as strings; arithmetic in `packages/shared/money.ts` with
  integer minor units (bigint) to avoid float errors. Currency per record, workspace base currency;
  multi-currency reporting via `exchange_rates` (v1.1).

### 4.9 Soft delete & recycle bin
- `deleted_at`, `deleted_by` on main entities; default scopes exclude deleted rows.
- Restore = clear `deleted_at` (same ID; links intact). Purge job hard-deletes after 30 days.

### 4.10 Security
- argon2id password hashing; login rate limiting; session rotation on login; logout revokes.
- CSRF: SameSite=Lax cookies + required `X-Requested-With` header on mutating requests.
- Strict CORS (same origin in prod), Helmet-style security headers, CSP for the SPA.
- No secrets in the repo: `.env` (git-ignored) + `.env.example`.
- Every query is workspace-scoped through a repository helper; tests assert cross-tenant isolation.

## 5. Frontend design

- **App shell**: Sidebar (desktop), collapsible rail (tablet), bottom tabs (mobile), top bar with
  search and "+ New".
- **Feature modules** own their pages, hooks (`useDeals`, `useMoveDeal`), and components.
- **Server state** only in TanStack Query; **UI state** in component state / URL (filters, sort,
  page, selected view are in the URL so they're shareable).
- **Optimistic Kanban**: move card instantly, call `/move`; on 422 open required-fields form; on
  error roll back and toast.
- **Design tokens** in Tailwind v4 `@theme` (colors, radius, spacing, fonts), dark mode via
  `data-theme`.
- **Feedback**: Toast (with Undo), inline field errors, skeletons, empty states, error boundaries
  per route.
- **Accessibility**: Radix primitives, dnd-kit keyboard sensor, visible focus, `aria-live` for
  toasts.

## 6. Quality strategy

| Level | What | Tooling |
|---|---|---|
| Unit | money math, permission predicates, validators, automation condition evaluator | Vitest |
| API integration | every endpoint: happy path, validation, permissions (own/team/all), tenant isolation, pagination/sort/filter | Vitest + real Postgres (CI service / docker compose) |
| E2E | sign-in, CRUD per entity, Kanban drag, conversion, won/lost, activities, search, filters, permissions as a restricted user | Playwright (Chromium) at 1440×900, 834×1112, 390×844 |
| Visual | screenshot review per screen and viewport during development | Playwright screenshots |
| Seed | realistic demo workspace (users, teams, 100+ records) for manual QA | `npm run db:seed` |

## 7. Environments & operations
- `docker compose up db` → local Postgres; `npm run dev` runs API (watch) + worker + Vite.
- Migrations via drizzle-kit, run on deploy before the app starts.
- Health endpoints `/healthz` (process) and `/readyz` (DB).
- Logs JSON to stdout; request IDs propagated to the client for support.

## 8. Extensibility (later)
Public REST API with API keys & webhooks, email sync (IMAP/Gmail), telephony via providers,
web-to-lead forms, estimates/invoices, custom objects ("smart processes"), mobile apps reusing the
same API.

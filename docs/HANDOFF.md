# Handoff — Acme CRM

Everything a new developer or AI agent needs to continue this project.

## 1. What this is

A full-stack CRM built from scratch, using Bitrix24 as a functional reference but with a much simpler UX.
The research behind every decision is in this folder:

| Read | For |
|---|---|
| `BITRIX24_ANALYSIS.md` | How the reference CRM works (tested in a real portal, with screenshots) |
| `CRM_WORKFLOWS.md` | The business rules we derived (conversion, won/lost, required-at-stage, recycle bin…) |
| `CRM_UX_REDESIGN.md` | UX principles, wireframes, design tokens — follow these for new screens |
| `CRM_ARCHITECTURE.md` | Architecture; the "As built" table lists where we deviated from the plan and why |
| `DATABASE_SCHEMA.md` | Tables, relations and service-layer rules |
| `CRM_FEATURES.md` / `IMPLEMENTATION_PLAN.md` | Scope and roadmap |

## 2. Status (Nov 2026)

**Built and tested (milestones 0–9 of the plan):**

- Auth: sign-up creates a workspace, sign-in/out, httpOnly session cookies, argon2id, rate limits, CSRF header, invite links.
- Contacts & companies: CRUD, multi-value phones/emails/websites, many-to-many contact↔company, live duplicate hints.
- Leads: board + list, stages, sources, disqualify with reason, **conversion** to contact/company/deal in one transaction
  with duplicate suggestions; open activities follow the lead.
- Deals: multiple pipelines, Kanban drag-and-drop with optimistic updates and undo, won/lost drop zones and buttons,
  lost reasons, reopen, list view with sum, line items with server-side money math (auto vs manual amount).
- Activities (task/call/meeting/email/deadline) linked to several records, reminders → notifications, "My day", overdue.
- Unified timeline (notes, activities, field-level history; contacts/companies also show related deals/leads).
- Products & categories.
- **CSV import** of contacts, companies and leads (`/import/:entity` → `/imports/:id`): upload (UTF-8 or Windows-1252,
  `,` `;` tab `|`, Excel `sep=`), auto-mapping by header (incl. custom fields), dry-run preview of every row, duplicate
  handling *skip / update / create* matched by email, phone, name or website (also against earlier rows of the same file),
  background run in chunks of 200 rows (one transaction each, savepoint per row → resumable), live progress, stop, report
  with row errors, failed-rows CSV for fix-and-reimport, undo (created records → recycle bin), history. Records are written
  through the same service functions as the forms, so validation, required fields and audit are identical; history shows
  "created by import of <file>". New role permission **Import** (built-in Managers have it; others get it in Roles).
- Custom fields (11 types) on leads/deals/contacts/companies; required always or **from a stage onward** (never when lost),
  enforced on the server and mirrored in the UI.
- Roles (Admin, Manager, Sales rep, Viewer + custom) with own/team/all scopes per entity×action; teams; private records;
  workspace isolation.
- Automation: rules per pipeline stage or on create, delays, conditions, actions (create activity, notify, add note,
  update field, assign owner fixed/round-robin, move stage), run log, loop guard.
- Dashboard (KPIs, pipeline by stage, won vs lost, my day, recent activity) and 8 reports with CSV export.
- Recycle bin: 30-day soft delete, restore keeps the same id; hourly purge job.
- Responsive layouts (sidebar / tablet rail / phone bottom tabs), dark mode, command palette (Ctrl/⌘-K).

**Quality:** 61 Vitest tests (API against real PostgreSQL), 13 Playwright tests (desktop, tablet, phone), lint and
typecheck clean, `npm audit` = 0, GitHub Actions CI in `.github/workflows/ci.yml`.

## 3. Not built yet — suggested next work (in priority order)

1. **Merge duplicates** (contacts, companies) — re-point deals, activities, notes, contact methods; audit it. The import
   report already tells users to "merge them first" when a row matches several records.
2. **Email delivery** for invitations and reminders (pluggable transport; today the invite link is shown to the admin).
3. **Global audit-log page** for admins (data already in `audit_events`, including `import` events).
4. **Saved views** on lists (table `saved_views` exists, no API/UI yet).
5. Business-hours aware automation delays; webhook action; "field changed" trigger.
6. Estimates/quotes and invoices with PDF (see `CRM_FEATURES.md`).
7. File custom fields and attachments (needs object storage).
8. Pipeline-level and field-level permissions.
9. Multi-currency reporting with exchange rates.
10. Import follow-ups: deals/products import, "add missing list options" during import, CSV export of lists.

Import limits and choices: 5 MB / 10,000 rows / 100 columns per file; lead rows only match *open* leads; dictionary
values (type, source, industry, size) must already exist; "Undo" does not revert updates; raw cells are kept 30 days.

Small known gaps: the Activities page opens on "Today" even when only "Upcoming"/"Overdue" have items; dashboard
chart colours don't switch live when the theme changes (they do after a reload).

## 4. Project map

```
apps/api/src
  app.ts            Fastify setup: cookies, helmet/CSP, rate limit, CSRF + session hook, error handler, SPA static serving
  server.ts         Migrates, starts HTTP, runs the background worker inline (INLINE_WORKER=false to disable)
  worker.ts         Standalone worker entry
  config.ts
  db/               pool.ts (pg + type parsers), sql.ts (tagged-template builder), migrate.ts, migrations/*.sql, seed.ts
  lib/              auth, permissions, audit, events (outbox), list (search/sort/paging), customFields, contactMethods,
                    records (insert/update helpers, camelCase), stages (stage changes), bootstrap (workspace defaults)
  imports/engine.ts CSV import: row → input, duplicate matching, preview, chunked runner (job `import.run`)
  routes/           auth, meta, parties (contacts+companies+duplicates), leads, deals, imports, activities (+notes, timeline,
                    history, notifications), products, search, settings, reports (+dashboard), automation, recycle
  automation/engine.ts  outbox → rules → jobs → actions; reminders; purge
apps/api/test       Vitest integration tests (helpers.ts signs up fresh workspaces)
apps/web/src
  app/              router, Layout (sidebar/rail/bottom tabs/top bar), CommandPalette, create.tsx (global drawers), auth pages
  components/ui     primitives, overlays (Dialog/Drawer/Menu/Popover), DataTable, StageBar, EntityPicker, stage colours
  features/         dashboard, deals (Board, useStageMove, CloseDialog), leads (ConvertDialog), contacts, companies, imports,
                    products (LineItemsEditor), activities, reports, settings/*, records (form, record, list, Timeline)
  lib/              api client, hooks (useMe/useMeta/useCan/useAction…), format, types
packages/shared/src enums, zod schemas, money math, normalisers
e2e/                Playwright specs + helpers; scripts/e2e-server.ts resets the e2e DB and starts the server
```

## 5. Run it locally

```bash
cp .env.example .env
docker compose up -d db            # PostgreSQL 16 with crm_dev + crm_test
npm ci
npm run db:migrate
npm run db:seed                    # demo@example.com / demo12345 (+ dara@, mia@, omar@example.com)
npm run dev                        # API :3000, web :5173 (proxies /api)
```

For e2e you also need a `crm_e2e` database (CI creates it): `createdb -O crm crm_e2e`.

### In a Claude Code cloud container (no Docker daemon)

Ubuntu images there ship PostgreSQL 16 and Node 22; the project needs Node 26. These commands were verified:

```bash
# Node 26 LTS (verify checksum), put first on PATH for project commands
V=v26.13.0; F=node-$V-linux-x64.tar.xz
curl -sSfO https://nodejs.org/dist/$V/$F && curl -sSfO https://nodejs.org/dist/$V/SHASUMS256.txt
grep " $F\$" SHASUMS256.txt | sha256sum -c - && mkdir -p /opt/node26 && tar -xJf $F -C /opt/node26 --strip-components=1
export PATH=/opt/node26/bin:$PATH

# PostgreSQL
service postgresql start
su postgres -c "psql -c \"CREATE ROLE crm LOGIN PASSWORD 'crm' CREATEDB;\""
su postgres -c "createdb -O crm crm_dev; createdb -O crm crm_test; createdb -O crm crm_e2e"

# Playwright: a Chromium is preinstalled at /opt/pw-browsers/chromium
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e
```

Gotchas learned the hard way:
- `pkill -f "<pattern>"` can match your own shell command and kill it; kill by PID instead.
- Background processes in the cloud sandbox are stopped after about 2 hours.
- `npm` commands must run with Node 26 first on PATH (`engine-strict=true`).

## 6. Production

`npm ci && npm run build`, then `NODE_ENV=production DATABASE_URL=… APP_URL=https://… npm start`.
One process serves `/api/v1/*` and the built SPA, runs migrations on start and runs jobs inline. Serve over HTTPS
(cookies are `Secure` in production). Health checks: `GET /api/v1/health`.

## 7. Key business rules (don't break these)

- Every row is scoped by `workspace_id`; tests in `permissions.test.ts` assert isolation.
- A deal's stage must belong to its pipeline; won/lost set `status` and `closed_at`; reopening clears them.
- Leads reach the won stage only through conversion; disqualify = lost stage.
- "Required from stage" = required at the earliest selected stage and every later stage (including won), never on lost.
- Restore from the recycle bin keeps the id. Purge after 30 days.
- Required fields are enforced by the API, not just the UI (Bitrix24 only enforced them in the UI).
- Amounts in `auto` mode always equal the sum of line items.

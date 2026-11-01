# Implementation Plan

Phase Five (build) starts **only after approval** of these documents. The plan delivers a working,
tested product at the end of every milestone; nothing is "decorative" — a button only ships with
the behaviour behind it.

Each milestone ends with: typecheck clean, unit + API tests green, Playwright e2e for the new
flows at desktop/tablet/mobile, screenshots reviewed, docs updated, commit pushed.

---

## Milestone 0 — Foundation
- Monorepo (`apps/web`, `apps/api`, `packages/shared`), TypeScript strict, ESLint/Prettier.
- Postgres via `docker compose`; Drizzle schema + first migration (workspaces, users, sessions,
  memberships, roles, role_grants, teams).
- Fastify app: error handler, request id, logging, zod type provider, `/healthz`, `/readyz`.
- Auth: sign-up (creates workspace + Admin), sign-in, sign-out, session cookie, `me` endpoint,
  password reset token flow (email delivery logged in dev).
- Web: Vite + Tailwind v4 tokens, app shell (sidebar / rail / bottom tabs), sign-in & sign-up
  pages, protected routes, toast system, error boundary, command palette skeleton.
- Design system v1: Button, Input, Select, Combobox, Dialog, Drawer, Tabs, Badge, Avatar,
  DataTable, EmptyState, Skeleton.
- CI workflow; seed script.
- **Exit:** a user can sign up, sign in, see the empty app shell on all viewports.

## Milestone 1 — Contacts & Companies
- Tables: companies, contacts, contact_companies, contact_methods, dictionary_items, notes,
  audit_events.
- API: CRUD, list with search/filter/sort/pagination/total, duplicates endpoint, soft delete,
  restore.
- Web: list pages (saved quick views, filter chips, column picker, bulk delete/assign),
  record pages (inline edit, contact methods editor, related company/contacts, notes timeline,
  history tab), create drawers with live duplicate hint.
- Recycle bin page.
- **Exit:** full CRUD + search + duplicates + restore, e2e green.

## Milestone 2 — Pipelines & Deals
- Tables: pipelines, stages, deals, deal_contacts, deal_stage_history, outbox_events.
- Settings → Pipelines & stages editor (create, rename, reorder, color, kind, probability).
- API: deal CRUD, `/move`, `/close` (won/lost + reason), `/reopen`; list aggregates (sum).
- Web: Kanban (dnd-kit, optimistic, column count+sum, quick add, won/lost drop zones, undo),
  list view with sum row, deal record page (stage bar, won/lost buttons, people panel, timeline).
- **Exit:** create deals, drag through stages, win/lose with reasons, history recorded.

## Milestone 3 — Leads & Conversion
- Lead pipeline (seeded stages), leads table, "Use leads" workspace setting.
- API: lead CRUD, `/convert` (contact/company/deal toggles, use-existing ids, required fields),
  `/disqualify`.
- Web: lead Kanban + list, lead record (Convert / Disqualify), conversion dialog with inline
  duplicate resolution.
- **Exit:** lead → contact + company + deal in one transaction, links & activities moved, e2e green.

## Milestone 4 — Activities, Tasks, Reminders, Notifications
- Tables: activities, activity_links, notifications; pg-boss worker.
- API: activity CRUD, complete/reopen, link to many records, "my activities" (today, overdue,
  upcoming), reminders job, notifications feed + mark read.
- Web: timeline composer (Note | Activity | Log call), "Up next" block, Activities page (My day,
  overdue, upcoming, by assignee), notification bell, Kanban card "next step" indicator.
- **Exit:** schedule/complete activities, reminders create notifications, overdue badges correct.

## Milestone 5 — Products & Line Items
- Tables: product_categories, products, line_items.
- API: product CRUD + categories; line items on deals with server-side math; amount auto/manual.
- Web: Products list & record, deal Products tab (search-or-create product, qty, discount, tax,
  totals), conversion copies lead line items.
- **Exit:** deal totals always consistent with rows; unit tests cover money math edge cases.

## Milestone 6 — Custom Fields & Dictionaries
- Table: field_definitions; `custom` jsonb validation; required always / from stage.
- Settings → Fields (per entity: add, edit, reorder, archive), Settings → Dictionaries (sources,
  lost reasons, types, industries…).
- Web: custom fields rendered in record pages, create forms, list columns and filters; Kanban
  "required fields" mini-form driven by API 422 response.
- **Exit:** admin adds a field required from "Proposal"; moving a deal there prompts for it (UI
  and API both enforce).

## Milestone 7 — Users, Teams, Roles & Permissions
- Invitations (link-based), user deactivation, teams, roles editor (one role per page),
  scope filters applied to every list, record check on every mutation, report scoping.
- Web: Settings → Users, Teams, Roles; UI hides actions the user can't perform.
- **Exit:** API test matrix (own/team/all × entity × action) green; e2e as a "Sales rep" proves
  restricted visibility.

## Milestone 8 — Dashboard & Reports
- Home dashboard: KPI tiles (open pipeline, weighted pipeline, won this period, win rate,
  overdue activities), pipeline-by-stage chart, won vs lost trend, my day, recent activity;
  scope toggle Me / Team / All.
- Reports: Won deals, Deals by stage, Deals by owner, Lead conversion (by source/owner), Overdue
  deals, Expected sales (weighted), Activities by user, Product sales; filters (period, pipeline,
  owner, team); CSV export.
- **Exit:** numbers match seeded fixtures exactly (API tests assert values).

## Milestone 9 — Automation
- Tables: automation_rules, automation_runs; outbox processor; actions: create activity, notify,
  add note, update field, assign owner (fixed / round-robin), move stage; delays; conditions;
  loop guard.
- Web: Settings → Automation (per pipeline, sentence-style editor in drawer), run log on records.
- **Exit:** e2e: rule "on enter Proposal → create task in 1 day" creates the task; delayed rule
  executes after the delay (time-travel in tests).

## Milestone 10 — Hardening & Polish
- CSV import (contacts, companies, leads) with mapping & dedupe; CSV export of lists.
- Global audit log page; merge contacts/companies.
- Accessibility pass (keyboard Kanban, focus, contrast), performance pass (indexes, N+1 checks,
  list virtualisation where needed), security pass (rate limits, headers, CSRF, tenant isolation
  tests).
- Full regression: functional (auth, CRUD, relations, pipeline movement, conversion, activities,
  search, filters, sorting, pagination, permissions, API errors) and visual (sidebar, dashboard,
  tables, forms, modals, dropdowns, Kanban at 1440 / 834 / 390 px).
- **Exit:** release candidate with seed demo workspace and operator docs.

---

## Later (post-v1 backlog)
Estimates & invoices (PDF), email integration (send/log via IMAP/SMTP or Gmail API), web-to-lead
forms, public API keys & webhooks, multi-currency reporting, business-hours delays, field-level
permissions, pipeline-level permissions, custom objects, mobile app, AI assist (summaries, next
step suggestions).

## Explicitly out of scope
Telephony, open channels/chat, intranet/feed, online store & inventory, e-signature, BI builder,
marketplace.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Scope creep (Bitrix24 is huge) | Milestone exit criteria; backlog for everything else |
| Permission bugs leaking data | Central scope predicate + exhaustive API matrix tests |
| Money rounding errors | Integer minor-unit math in `packages/shared`, property-based tests |
| Kanban performance with many deals | Server pagination per column ("load more"), virtualised lists |
| Automation loops / storms | Depth guard, per-rule rate limit, run log with errors |
| Postgres not available in CI/dev | `docker compose` + GitHub Actions Postgres service |

## Open questions for the owner
1. Product name and brand color (placeholder: "Acme CRM", indigo).
2. Single company use first, or multi-workspace SaaS sign-up from day one? (Data model supports
   both; UI defaults to one workspace.)
3. Default language/currency (proposal: English, USD; Khmer/KHR later?).
4. Hosting target (VPS with Docker, or a PaaS) — affects deploy scripts only.
5. Should estimates/invoices move into v1?

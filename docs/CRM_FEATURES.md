# CRM Features — Inventory & Scope

Every module and feature identified in Bitrix24, with its verification status and the scope we
propose for **our** CRM.

**Status (Bitrix24):** ✅ tested · 👁 observed · 📄 API metadata only · ❌ blocked · ⏭ not explored
**Our scope:** **MVP** = first release · **v1.1** = soon after · **Later** = roadmap · **Out** = not planned

---

## 1. Platform

| Feature | Bitrix24 | Our scope | Notes |
|---|---|---|---|
| Email + password sign-in | 👁 (bitrix24.net SSO) | MVP | Sessions in httpOnly cookies, argon2 hashing |
| Social / SSO sign-in | 👁 Google, Apple, MS, Facebook | Later | OAuth/OIDC |
| Two-factor auth | 👁 | Later | TOTP |
| Workspaces (multi-tenant) | 👁 one portal per company | MVP (data model) | `workspace_id` on every row; single-workspace UI first |
| User invitations | 👁 (not tested — sends email) | MVP | Invite link; email delivery pluggable (dev: log to console) |
| Departments / teams | 👁 company structure | MVP (teams) | Flat teams v1, hierarchy later |
| Global search | 👁 top bar | MVP | Cmd-K across leads/deals/contacts/companies |
| Notifications | ✅ system notifications fired | MVP | In-app bell; email digests later |
| Light/dark theme | 👁 themes (wallpapers) | MVP | Token-based, no wallpapers |
| Mobile/responsive | 👁 cramped | MVP | Designed mobile-first for lists & detail |
| Localisation, currencies | 📄 5 currencies, base USD | v1.1 | Multi-currency amounts with base-currency reports |
| REST API / webhooks | 📄 | MVP (internal API) / Later (public) | Our frontend uses the same JSON API |

## 2. Dashboard

| Feature | Bitrix24 | Our scope |
|---|---|---|
| CRM home dashboard | ❌ none (Feed); BI boards paywalled | **MVP** — KPI tiles, pipeline by stage, my day, overdue, recent activity |
| Per-user customization | ⏭ | Later (widget picker) |

## 3. Leads

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Create / edit / delete | ✅ | MVP |
| Quick create from Kanban | ✅ | MVP |
| Stages (open / converted / junk) | ✅ | MVP (configurable lead pipeline) |
| Sources dictionary | ✅ | MVP (editable) |
| Responsible user, observers | ✅ / 👁 | MVP (owner) / v1.1 (followers) |
| Duplicate detection | ✅ warning | MVP (warning + open existing) / v1.1 (merge) |
| Conversion → contact / company / deal (7 combos) | ✅ | MVP (single dialog with checkboxes) |
| Kanban, list, activity views | ✅ | MVP (Kanban + list) |
| UTM fields | 📄 | v1.1 |
| Lead forms / chat / telephony capture | 👁 | Later (web form + API ingestion) |
| Toggle "use leads" (Simple vs Classic) | ✅ | MVP (setting) |

## 4. Deals

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Create / edit / delete / copy | ✅ | MVP |
| Multiple pipelines | ✅ | MVP |
| Stages with open/won/lost semantics | ✅ | MVP |
| Kanban with column sums & counts | ✅ | MVP |
| Drag & drop stage change | ✅ | MVP |
| Required-field prompt on stage change | ✅ | MVP (server-enforced) |
| Won / lost with reason | ✅ | MVP |
| Undo after stage change / close | ✅ | MVP |
| List view (sort, filter, paging) | ✅ | MVP |
| Calendar view (by close date) | 👁 | v1.1 |
| Activities view (by next activity due) | 👁 | v1.1 (as a "Next step" column & filter) |
| Contacts (many) + company (one) | ✅ | MVP |
| Products / line items | ⚠️ catalog broken | MVP |
| Amount auto vs manual | ✅ | MVP |
| Probability, expected close date | 📄 | MVP |
| Deal type | 📄 | MVP (dictionary) |
| History / audit | ✅ | MVP |
| Timeline (notes, activities, events) | ✅ | MVP |
| Estimates (quotes) | 👁 | Later |
| Invoices / payments | 👁 | Later |
| Recurring deals, repeat sales | 📄 / 👁 | Later |
| Tunnels between pipelines | 👁 | Later (automation action "create deal in pipeline") |

## 5. Contacts & companies

| Feature | Bitrix24 | Our scope |
|---|---|---|
| CRUD | ✅ | MVP |
| Multi-value phones / emails / websites / messengers with labels | ✅ | MVP |
| Contact ↔ many companies | 📄 | MVP (one primary + others) |
| Contact type / company type / industry / size | 📄 | MVP (dictionaries) |
| Related deals, activities, timeline aggregation | ✅ | MVP |
| Addresses | 📄 | MVP (one structured address each; billing for companies) |
| Requisites / legal details | 📄 | Later |
| "My company" entities | 📄 | Later |
| Photo / logo | 📄 | v1.1 |
| Import / export CSV | 👁 | v1.1 |

## 6. Activities & tasks

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Notes / comments with pin | ✅ | MVP |
| To-do with due date, reminder | ✅ | MVP |
| Calls, meetings, emails (logged) | 📄 | MVP (as activity kinds; no telephony/email sync) |
| Tasks (assignee, deadline, priority) | ✅ | MVP (as activity kind "task") |
| Checklists, sub-tasks, time tracking, Gantt | 👁 | Later |
| Link one activity to several records | ✅ | MVP |
| My activities / My day | ✅ | MVP |
| Overdue counters | 👁 | MVP |
| Calendar sync, video calls | 👁 | Out (for now) |

## 7. Products

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Catalog CRUD | ❌ blocked | MVP |
| Categories (sections) | 📄 | MVP |
| Price, currency, unit, tax rate, tax included, SKU/code, active | 📄 | MVP |
| Images | 📄 | v1.1 |
| Line items on deals with qty, discount (% / fixed), tax | ⚠️ | MVP |
| Line items on leads | 📄 | v1.1 |
| Variants (SKU offers), inventory, warehouses | 👁 | Out |

## 8. Automation

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Rules per pipeline stage | ✅ | MVP |
| Delays (immediate / after N / business hours) | ✅ | MVP (immediate + delay) / v1.1 (business hours) |
| Conditions | 👁 | MVP (simple field conditions) |
| Actions: create activity, notify, add note, update field, change owner, move stage | ✅ (catalogue) | MVP |
| Send email / SMS to customer | 👁 | Later |
| Triggers that move items (email opened, form submitted…) | 👁 | Later (field-change trigger in v1.1) |
| Test mode, run logs | 👁 | MVP (run log) |
| Workflow designer (BPMN) | 👁 | Out |
| Webhook action | ⏭ | v1.1 |

## 9. Users & permissions

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Roles (Admin, Manager, Sales rep, Viewer) | 👁 5 defaults | MVP |
| Per-entity actions × scope (own/team/all) | 👁 | MVP |
| Record visibility flag ("available to everyone") | 📄 | MVP (`visibility: shared/private`) |
| Pipeline-level permissions | 👁 | v1.1 |
| Move-to-stage permission, hide amounts | 👁 | Later |
| Field-level visibility | 👁 | Later |
| Assignment rules / round-robin | ⏭ | v1.1 (automation action "assign round-robin") |

## 10. Reports & analytics

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Won deals, deals by stage, by owner, by company/contact | ✅ | MVP |
| Leads by stage / source / owner, conversion rate | 👁 | MVP |
| Overdue deals, expected sales (weighted pipeline) | 👁 | MVP |
| Activity report per user | 👁 | v1.1 |
| Product sales | 👁 | v1.1 |
| Sales trend over time, cohort, churn | ❌ paywalled | v1.1 (trend) / Later |
| CSV export of any report | 👁 | v1.1 |
| Custom report builder | 👁 | Later |

## 11. Settings & customization

| Feature | Bitrix24 | Our scope |
|---|---|---|
| Pipelines & stages editor | ✅ | MVP |
| Dictionaries (sources, types, industries, lost reasons) | ✅ | MVP |
| Custom fields — text, number, money, date, datetime, yes/no, list (single/multi), URL, user, file | ✅ | MVP (all but file) / v1.1 (file) |
| Required always / required from stage | ✅ | MVP |
| Field sections & ordering per entity | 👁 | v1.1 |
| Per-user form layouts | 👁 | Out (one layout per workspace, admin-controlled) |
| Currencies & taxes | 📄 | v1.1 |
| Recycle bin (30 days) | ✅ | MVP |
| Audit log (global) | ✅ | MVP (per record) / v1.1 (global) |
| Integrations marketplace | 👁 | Out |

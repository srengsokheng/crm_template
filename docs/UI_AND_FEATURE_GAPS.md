# UI & feature gap audit (Nov 2026)

An honest list of what is weak or missing, found by reviewing the code and the running app. Work through it top to
bottom. Each item names the project skill in `.claude/skills/` that helps.

## A. Design system & components (fix first — everything else builds on it)

| # | Gap | What "done" looks like | Skill |
|---|---|---|---|
| A1 | Only 7 shared UI files; screens hand-roll layouts, tabs, filters, empty states and section headers | `apps/web/src/components/ui` has one component per pattern (Button, IconButton, Input, Select, Textarea, Field, Checkbox, Radio, Switch, Badge, Avatar, Card, Section, PageHeader, Tabs, Toolbar, FilterBar, DataTable, Pagination, EmptyState, ErrorState, Skeleton, Dialog, Drawer, Menu, Popover, Toast, Tooltip, StageBar, Kanban) and pages use only these | frontend-design, refactoring |
| A2 | No written UI rules | `docs/UI_GUIDELINES.md`: tokens (spacing 4/8/12/16/24/32, type scale, colours, radius, shadow), when to use Drawer vs Dialog vs page, button hierarchy (one primary per screen), copy rules (sentence case), form layout, table rules, states | frontend-design, wireframing |
| A3 | Tap targets too small (icon buttons 28px, checkboxes 16px) | ≥ 44×44px touch targets on phone/tablet; ≥ 32px on desktop | frontend-design |
| A4 | No component gallery | A `/dev/components` route (dev builds only) showing every component in every state, light + dark — used for visual review | frontend-design |
| A5 | No accessibility testing | `@axe-core/playwright` (or equivalent, pinned, audit 0) in e2e: zero serious/critical violations on every main page; keyboard-only path through Kanban, dialogs, pickers; focus trapped in dialogs; headings hierarchy | accessibility-testing |
| A6 | Inline-edit pencil rows are the only edit mode | Add a full "Edit" drawer on record pages for editing many fields at once; keep inline edit for quick changes | wireframing |

## B. Pagination & lists

| # | Gap | Where | Fix |
|---|---|---|---|
| B1 | Timeline returns fixed 200/300 items | `routes/activities.ts` timeline | Cursor (`before=<timestamp,id>`) + "Load more" button |
| B2 | Related deals capped at 50, no paging | `routes/parties.ts` contact & company detail | Use `/deals?contactId=` / `?companyId=` with the standard `Pagination` component |
| B3 | Kanban columns show "+N more" with no way to load them | `deals/Board.tsx`, `/deals/board` | Per-column "Load more" (`/deals/board?stageId=&offset=`) |
| B4 | Notifications capped at 50 | `/notifications` | Paging + "View all" page |
| B5 | Recycle bin capped at 500, automation runs at 100 | `recycle.ts`, `automation.ts` | Standard `page/pageSize/total` |
| B6 | Activities page has pagination but no page-size selector; Settings lists (users, fields, dictionaries) have none | various | Shared `Pagination` everywhere a list can exceed 25 rows |
| B7 | Column picker and saved views promised in the UX doc but missing (`saved_views` table unused) | lists | Column picker per list (persisted per user) + saved views API/UI | 

Rule to add to `docs/UI_GUIDELINES.md`: **every list that can grow unbounded is paginated server-side and shows total
count; nothing is silently truncated.** (api-design skill: consistent pagination metadata.)

## C. Missing or incomplete features

| Priority | Feature | Notes |
|---|---|---|
| P0 | **Change password, forgot/reset password, profile page** (name, email, theme, timezone) | Currently impossible to change a password |
| P0 | **Edit/delete products categories UI**; product detail page | API exists, UI partial |
| P1 | CSV import (contacts, companies, leads) with mapping, preview, dedupe, error report | |
| P1 | Merge duplicate contacts/companies | crm-data-enrichment skill (matching + survivorship rules) |
| P1 | Email delivery (invites, reset password, reminders) — console in dev, SMTP in prod | |
| P1 | CSV export of any list (respecting filters and export permission) | only reports export today |
| P2 | Deal calendar view (by expected close) and activity calendar | Bitrix24 had both |
| P2 | Admin audit-log page (`audit_events`) with filters | |
| P2 | File attachments on notes/records | needs object storage |
| P2 | Dashboard period selector (this month / quarter / custom) and per-pipeline report charts | |
| P2 | Lead scoring (fit + engagement, Hot/Warm/Cold badges, sort by score) | lead-scoring skill |
| P3 | Estimates/quotes & invoices with PDF; business-hours automation delays; webhook action; field-change trigger | |
| P3 | Pipeline-level and field-level permissions; multi-currency reporting | |

## D. Small known issues

- Activities page opens on "Today" even when only Overdue/Upcoming have items — default to the first non-empty tab.
- Dashboard chart colours don't switch live on theme change (needs a theme context/hook).
- Board cards truncate next-activity text without a tooltip.
- Delete confirmation exists for bulk delete but single delete relies on undo toast only — document this as intended.

## E. How to verify UI work

For every screen changed: screenshots at 390 / 834 / 1440 px in light and dark, zero horizontal scroll, axe clean,
keyboard path works, loading/empty/error states shown, Playwright test for the main flow. Run the `code-review` skill on
the branch before opening the PR.

# Remaining UI & feature gaps

Checked against the tip of the open branch chain (`feat/whatsapp-notices` + `fix/reminder-test-clock`, 20 Nov 2026).
Already done there and not repeated here: password reset and change, account email change, saved views, CSV
import/export, audit log, duplicates/merge, "Load more" feeds, `docs/UI-RULES.md`, attachments, quotes/invoices and
payments (KHQR), payment reminders, inbox (Telegram, Meta, WhatsApp), broadcasts, booking pages, calls, webhooks,
targets, axe checks in e2e (`e2e/a11y.spec.ts`), keyboard Kanban move (`e2e/board.spec.ts`).
Integration follow-ups (CJK PDFs, real Telegram/Meta accounts, TURN/SFU, broadcast limits, booking calendar sync,
KHQR Bakong API…) are listed in `docs/HANDOFF.md` §3 — not duplicated here.
Skills that help are in `.claude/skills/` (see its README).

## 0. Before anything else: get the work into `main`

`main` only has PRs #1–#4. About 65 commits sit on a stack of ~62 open PRs (#5 `feat/password-reset` → … → #66
`feat/whatsapp-notices`, each based on the previous branch), plus #40 (`fix/audit-policy`, into `main`) and the
test fix on `fix/reminder-test-clock`. Until they are merged, every new branch must start from the top of the stack.

Suggested order: merge #40, then the stack bottom-up (or retarget #66 + the fix to `main` and merge once, if the owner
prefers one big merge). Run the `code-review` skill on the risky parts first (payments, public customer links,
webhooks, messaging, permissions). CI must be green; merge only with the owner's OK.

## 1. Design system (frontend-design, refactoring)

- **More shared components.** `components/ui` still has 8 files; screens hand-build tabs, toolbars, filter bars,
  section headers, radio groups, switches and tooltips. Add `Tabs`, `Toolbar`/`FilterBar`, `Section`, `RadioGroup`,
  `Switch`, `Tooltip`, `KeyValueList`; replace the hand-built versions (behaviour unchanged, one refactor PR).
- **Component gallery**: a dev-only `/dev/components` page showing every component in every state, light + dark.
- **Touch targets**: `UI-RULES.md` asks for 44px, but `IconButton size="sm"` and checkboxes are smaller and nothing
  enlarges them on touch screens. Enforce ≥44px under `pointer: coarse` and add a Playwright check at 390px.

## 2. Lists & pagination (api-design)

- ~~**Kanban columns**: per-column "Show more"~~ — done (`more=stageId:count` on `/deals/board` and `/leads/board`, up to 500 cards a column).
- ~~**Related deals** on contact and company pages~~ — done: 10 inline with `dealsTotal`, "Load more" pages
  `/deals?contactId=|companyId=`, open-pipeline sum over all of them; now filtered by the deal view scope too.
- Column picker per list (saved with the saved view).

## 3. Missing features

| Priority | Feature |
|---|---|
| P1 | **Edit drawer** on record pages to edit many fields at once (inline edits stay for quick changes) |
| P1 | **Calendar views**: deals by expected close date, activities and bookings by date (week/month, drag to reschedule) |
| P1 | **Dashboard period picker** (this month / quarter / year / custom) and a pipeline picker; today only the Me / My team / Everyone scope switch exists |
| P2 | **Lead scoring** (lead-scoring skill): fit + engagement score, Hot/Warm/Cold badge, sort and filter by score |
| P2 | **User-flow diagrams** (user-flow-mapping skill) for lead→deal, import, merge, invoice→payment, booking — in `docs/flows/` |
| P2 | Profile extras: personal time zone, sign out of other sessions |

## How to verify UI work

Screenshots at 390 / 834 / 1440 px in light and dark; no horizontal page scroll; axe clean; keyboard path works;
loading, empty and error states shown; a Playwright test for the main flow; `code-review` skill run before the PR.
Tick items off here in the same PR.

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
- ~~**Touch targets**~~ — done: 44px tap areas on touch screens (global rule in `styles.css`), checked by
  `e2e/touch-targets.spec.ts`.

## 2. Lists & pagination (api-design)

- ~~**Kanban columns**: per-column "Show more"~~ — done (`more=stageId:count` on `/deals/board` and `/leads/board`, up to 500 cards a column).
- ~~**Related deals** on contact and company pages~~ — done: 10 inline with `dealsTotal`, "Load more" pages
  `/deals?contactId=|companyId=`, open-pipeline sum over all of them; now filtered by the deal view scope too.
- Column picker per list (saved with the saved view).

## 3. Missing features

| Priority | Feature |
|---|---|
| ~~P1~~ | ~~**Edit drawer**~~ — done: **Edit** on deal, lead, contact and company pages opens the create form pre-filled; only changed fields are sent, with the record version (a conflicting save is refused) |
| ~~P1~~ | ~~**Calendar views**~~ — done: `/calendar` (month/week; phones get an agenda) with activities by due time and open deals by expected close, drag to another day with Undo, Mine/Everyone. Still open: bookings on it, and a keyboard way to move items (today: change the date on the record) |
| ~~P1~~ | ~~**Dashboard period picker**~~ — done: this/last month, quarter, year, or a custom range (remembered per browser); the pipeline picker was already there |
| P2 | **Lead scoring** (lead-scoring skill): fit + engagement score, Hot/Warm/Cold badge, sort and filter by score |
| P2 | **User-flow diagrams** (user-flow-mapping skill) for lead→deal, import, merge, invoice→payment, booking — in `docs/flows/` |
| P2 | Profile extras: personal time zone, sign out of other sessions |

## How to verify UI work

Screenshots at 390 / 834 / 1440 px in light and dark; no horizontal page scroll; axe clean; keyboard path works;
loading, empty and error states shown; a Playwright test for the main flow; `code-review` skill run before the PR.
Tick items off here in the same PR.

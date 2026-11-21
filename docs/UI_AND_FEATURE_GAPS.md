# Remaining UI & feature gaps

Checked against `main` (21 Nov 2026).
Already done there and not repeated here: password reset and change, account email change, saved views, CSV
import/export, audit log, duplicates/merge, "Load more" feeds, `docs/UI-RULES.md`, attachments, quotes/invoices and
payments (KHQR), payment reminders, inbox (Telegram, Meta, WhatsApp), broadcasts, booking pages, calls, webhooks,
targets, axe checks in e2e (`e2e/a11y.spec.ts`), keyboard Kanban move (`e2e/board.spec.ts`).
Integration follow-ups (CJK PDFs, real Telegram/Meta accounts, TURN/SFU, broadcast limits, booking calendar sync,
KHQR Bakong API…) are listed in `docs/HANDOFF.md` §3 — not duplicated here.
Skills that help are in `.claude/skills/` (see its README).

## 0. ~~Get the work into `main`~~ — done (21 Nov 2026)

The whole stack (#5–#73) and #40 are merged into `main`. Start every new branch from `main` and open the pull request
into `main`.

## 1. Design system (frontend-design, refactoring)

- ~~**Component gallery**~~ — done: `/dev/components` (every shared component and state; in the a11y scan).
- ~~**More shared components**~~ — done: `Tabs`, `RadioGroup` and `Switch` (`components/ui/controls.tsx`) replace the
  hand-built tab bars and radio lists; `Segmented` and `Tabs` move with the arrow keys; settings that save at once
  (list options, automation rules, Telegram group chats) use `Switch`. `Toolbar`, `SearchBox` and `FilterSelect` already
  live in `features/records/list.tsx` and `EditRow` in `record.tsx` (the key–value rows), so no new ones are needed;
  icon-button tooltips stay native `title` + `aria-label`.
- ~~**Touch targets**~~ — done: 44px tap areas on touch screens (global rule in `styles.css`), checked by
  `e2e/touch-targets.spec.ts`.

## 2. Lists & pagination (api-design)

- ~~**Kanban columns**: per-column "Show more"~~ — done (`more=stageId:count` on `/deals/board` and `/leads/board`, up to 500 cards a column).
- ~~**Related deals** on contact and company pages~~ — done: 10 inline with `dealsTotal`, "Load more" pages
  `/deals?contactId=|companyId=`, open-pipeline sum over all of them; now filtered by the deal view scope too.
- ~~Column picker per list~~ — done: **Columns** on Deals, Leads, Contacts and Companies lists; kept in the URL (`cols=`), so saved views and links keep it.

## 3. Missing features

| Priority | Feature |
|---|---|
| ~~P1~~ | ~~**Edit drawer**~~ — done: **Edit** on deal, lead, contact and company pages opens the create form pre-filled; only changed fields are sent, with the record version (a conflicting save is refused) |
| ~~P1~~ | ~~**Calendar views**~~ — done: `/calendar` (month/week; phones get an agenda) with activities by due time and open deals by expected close, drag to another day with Undo (keyboard: an item's grip button, Space, arrows, Space), Mine/Everyone. Bookings show as the meeting each one creates for its host |
| ~~P1~~ | ~~**Dashboard period picker**~~ — done: this/last month, quarter, year, or a custom range (remembered per browser); the pipeline picker was already there |
| ~~P2~~ | ~~**Lead scoring**~~ — done: 0–100 (fit 50 + engagement in the last 30 days 50), Hot ≥ 70 / Warm ≥ 40 / Cold; badge on the lead list and board, sort by score, filter by tier, breakdown on the lead page, Score column in CSV export. Weights in `packages/shared/src/leadScore.ts` |
| P2 | **User-flow diagrams** (user-flow-mapping skill) for lead→deal, import, merge, invoice→payment, booking — in `docs/flows/` |
| ~~P2~~ | ~~Profile extras~~ — done: Settings → Your account has a time zone for your emails (reminders, digest; empty = the workspace's) and “Where you’re signed in” with sign-out of other devices |

## How to verify UI work

Screenshots at 390 / 834 / 1440 px in light and dark; no horizontal page scroll; axe clean; keyboard path works;
loading, empty and error states shown; a Playwright test for the main flow; `code-review` skill run before the PR.
Tick items off here in the same PR.

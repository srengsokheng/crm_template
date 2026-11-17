# Remaining UI & feature gaps

Checked against the tip of the open branch chain (`feat/feeds-everywhere`, 17 Nov 2026). Items already done there —
password reset by email, saved views, list CSV export, audit log, find/merge duplicates, "Load more" feeds,
`docs/UI-RULES.md`, attachments, quotes/invoices, inbox, permissions, multi-currency — are not repeated here.
Skills that help are in `.claude/skills/` (see its README).

## 0. Before anything else: get the work into `main`

`main` only has PRs #1–#4. 32 commits sit on a stack of unmerged branches
(`feat/password-reset` → … → `feat/feeds-everywhere`). Until they are merged, every new branch must start from
`feat/feeds-everywhere`, and reviewing one giant change later gets harder every day.
Open one PR per branch in stack order (or one PR from `feat/feeds-everywhere` if the owner prefers), run the
`code-review` skill on each, make CI green, and merge into `main` with the owner's OK.

## 1. Design system (frontend-design, refactoring)

- **More shared components.** `components/ui` still has 8 files; screens hand-build tabs, toolbars, filter bars,
  section headers, radio groups, switches and tooltips. Add `Tabs`, `Toolbar`/`FilterBar`, `Section`, `RadioGroup`,
  `Switch`, `Tooltip`, `KeyValueList`; replace the hand-built versions (behaviour unchanged, one refactor PR).
- **Component gallery**: a dev-only `/dev/components` page showing every component in every state, light + dark —
  the place to review visual changes.
- **Touch targets**: `UI-RULES.md` says 44px but `IconButton size="sm"` is 28px and checkboxes 16px. Enforce ≥44px on
  touch screens (`pointer: coarse`) and add a Playwright check at 390px.

## 2. Accessibility (accessibility-testing)

- Add automated axe checks (`@axe-core/playwright`, pinned, `npm audit` stays 0) to e2e for every main page in light
  and dark; fail on serious/critical.
- Keyboard-only e2e path: create a deal, move it on the Kanban (dnd-kit keyboard sensor), win it, open a dialog and
  close it with Escape (focus returns to the trigger).

## 3. Lists & pagination (api-design)

- **Kanban columns** still stop at 50 cards with "+N more" — add per-column "Load more".
- Related deals on contact/company pages: confirm they use paging/feeds everywhere (earlier capped at 50).
- Column picker per list (saved with the saved view).

## 4. Missing features

| Priority | Feature |
|---|---|
| P0 | **Change password while signed in** and a **profile page** (name, email with re-verification, time zone, theme, sign out of other sessions) — today only forgot/reset by email exists |
| P1 | **Edit drawer** on record pages to edit many fields at once (inline pencil edits stay for quick changes) |
| P1 | **Calendar views**: deals by expected close date, activities by due date (week/month, drag to reschedule) |
| P1 | **Dashboard period picker** (this month / quarter / year / custom) and a pipeline picker for the charts |
| P2 | **Lead scoring** (lead-scoring skill): fit + engagement score, Hot/Warm/Cold badge, sort and filter by score |
| P2 | **User-flow diagrams** (user-flow-mapping skill) for lead→deal, import, merge, invoice — in `docs/flows/` |
| P3 | Items in `docs/HANDOFF.md` §3 (CJK PDFs, more inbox channels, live widget updates) |

## How to verify UI work

Screenshots at 390 / 834 / 1440 px in light and dark; no horizontal page scroll; axe clean; keyboard path works;
loading, empty and error states shown; a Playwright test for the main flow; `code-review` skill run before the PR.
Tick items off here in the same PR.

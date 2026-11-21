# UI rules

How screens in this app are built. Every new or changed screen follows these rules; reviewers check against them.
The components named here live in `apps/web/src/components/ui/` and `apps/web/src/features/records/`.
(Adapted in part from the MIT-licensed `frontend-design` and `accessibility-testing` skills in
seb1n/awesome-ai-agent-skills, extended with the table, list, form and state rules they don't cover.)

## 1. Foundations

- **Colours** only through the CSS variables in `styles.css` (`--bg`, `--surface`, `--surface-2`, `--border`, `--text`,
  `--muted`) and the `brand-*` palette; status colours through `Badge` tones (`green`, `red`, `amber`, `blue`, `slate`,
  `brand`). Never hard-code hex values in components; every colour must work in light and dark.
- **Type**: Inter. Sizes in use: 11px (meta, badges), 12px (secondary), 13px (UI text, nav, table headers), 14px
  (body, inputs), 15px (record titles), 18px+ (page titles via `PageHeader`). Don't add new sizes.
- **Spacing**: Tailwind's 4px scale only (`1`=4px, `2`=8px, `3`=12px, `4`=16px, `6`=24px, `8`=32px). Cards use `p-4`,
  page sections `space-y-4`, form fields `space-y-3`.
- **Radius**: `--radius-control` (inputs, buttons) and `--radius-card` (cards, tables, dialogs). Nothing else.
- **Numbers** right-aligned with `tabular` in tables; money only through `money()` from `lib/format.ts`; dates through
  `date()`, `dateTime()`, `relative()`, never `toLocaleString()` in components.

## 2. Components — use these, don't rebuild them

| Need | Use | Notes |
|---|---|---|
| Buttons | `Button` (`primary` / default / `ghost`), `IconButton` | `IconButton` requires `label` (becomes `aria-label` + tooltip). |
| Inputs | `Input`, `Textarea`, `Select`, `Checkbox`, `Segmented` inside `Field` | `Field` gives the label, hint, required mark and error. |
| Record lists (paged) | `DataTable` + `Pagination` + `useListParams` | Filters, sort and page live in the URL. |
| Feeds and secondary lists | `FeedList` + `useFeed` | Newest first, "Load more", never silently cut off. See §3. |
| Cards / sections | `Card` (`title`, `actions`) | One card per topic; `padded={false}` for lists inside. |
| States | `Skeleton`, `EmptyState`, `ErrorState`, `Spinner` | See §5. |
| Dialogs | `Dialog`, `ConfirmDialog`, `Drawer` | Destructive actions always go through `ConfirmDialog`. |
| Menus / popovers | `Menu`, `Popover` | |
| Pickers | `EntityPicker`, `MultiEntityPicker`, `UserSelect` | Async search; never a `<select>` with every record. |
| Page title row | `PageHeader` | Title, subtitle, actions. |
| Notifications | `toast.success / toast.error` (sonner) | Success after every save; errors with the API message. |

If a screen needs something that isn't here, add it to `components/ui/` (with its states) instead of styling a
one-off in the feature.

## 3. Lists, tables and pagination

**No list may grow without limit, and no list may silently drop rows.**

- **Record lists** (leads, deals, contacts, companies, products, invoices, activities, audit log): `DataTable` with
  server-side `page`/`pageSize` (25/50/100) and a total, via `runList` in the API. Sort by clicking headers; search
  and filters next to the title; state in the URL so views can be shared and survive reloads.
- **Feeds** (record history, inbox conversations and messages, notifications, recycle bin, import history, run and
  delivery logs): newest first, `limit` (default 50, max 100) and an opaque `before` cursor; the API returns
  `{ data, nextCursor }` (`feedQuery` / `feedResult` in `apps/api/src/lib/list.ts`). The UI shows **"Load more"**
  while `nextCursor` is set and nothing when it isn't. Use offset paging only where a total is shown.
- **API rule**: an endpoint returning a list either pages (`runList`) or takes a cursor (`feedQuery`). A bare
  `LIMIT n` is only allowed when the UI says so in words (e.g. "the 5 most recent").
- Tables scroll horizontally **inside** their card, never the page. On phones hide secondary columns with
  `hideOnMobile`; the first column always identifies the row and links to it.
- Row click opens the record; checkboxes for bulk actions stop propagation. Bulk actions appear only when rows are
  selected and show how many.
- Long text truncates with `truncate` (and a `title` when the full value matters); never let it widen the layout.

## 4. Forms

- Every input has a visible label (`Field label=…`); placeholders are examples, not labels. Required fields are marked.
- Validation comes from the shared zod schemas; show the API's `fields` errors next to the inputs, keep what the user
  typed, and focus the first invalid field.
- The submit button is disabled while saving and shows progress ("Saving…"); Enter submits single-line forms.
- Success: close the dialog/drawer and `toast.success`. Failure: keep it open and `toast.error(errorMessage(e))`.
- Fields the user's role can't change are read-only (`useFieldLock`), hidden ones aren't rendered at all.
- Destructive or irreversible actions: `ConfirmDialog` that says what happens and whether it can be undone.

## 5. States (every data view)

| State | Show |
|---|---|
| Loading | `Skeleton`s shaped like the content (rows, cards) — not a full-page spinner. |
| Empty | `EmptyState` with what will appear here, and an action if the user may create one. Different text for "no results for this search/filter" vs "nothing yet". |
| Error | `ErrorState` with the message and **Try again**. Never a blank area. |
| Partial | "Load more" (feeds) or pagination (tables). |
| No permission | A sentence saying why (e.g. "You can read this conversation but your role can't reply"), not a disabled control with no explanation. |

## 6. Buttons and actions

- **No decorative buttons**: every button does something now. Not-yet-built features are not shown.
- One `primary` button per view (the main action). Secondary actions are default or `ghost`, or go in a `Menu`.
- Actions the user can't take are hidden (`useCan`), unless knowing they exist matters — then disabled with the reason
  in visible text.
- Labels are verbs in sentence case: "Create invoice", "Mark as paid", not "Submit" or "OK".

## 7. Layout and responsiveness

- Check every screen at **390, 834 and 1440 px, light and dark**. No horizontal page scroll at any width.
- Phones: one column; side panels stack below; list/detail screens become two screens (see the Inbox).
- Controls are at least 36px tall (`h-9`); icon-only buttons at least 28px with 8px between them; phone navigation
  items at least 44px.
- Touch screens: `styles.css` gives every button, tab, switch and menu item an invisible 44×44px tap area
  (`@media (pointer: coarse)`), and checkboxes/radios 24px — don't override `::after` on controls. New controls must be
  real `<button>`s (or carry one of those roles) to get it; `e2e/touch-targets.spec.ts` checks the main pages at 390px.
- Content max width comes from the layout (`max-w-[1600px]`); forms in dialogs, not full-width pages.

## 8. Accessibility (WCAG 2.1 AA)

- Semantic elements first: `button` for actions, `a`/`Link` for navigation, `table` for tabular data, headings in
  order (one `h1` per page). ARIA only where HTML can't express it.
- Every control has an accessible name (label, `aria-label` on icon buttons, `alt` on images; `alt=""` for decoration).
- Visible focus on everything interactive (the default ring — don't remove outlines). Full keyboard use: Tab order
  follows the layout, Esc closes dialogs and popovers, focus returns to the trigger.
- Text contrast ≥ 4.5:1 (3:1 for large text and UI borders) in both themes; never convey meaning by colour alone
  (badges have text, errors have words).
- Content that updates by itself (inbox, toasts, upload results) is in an `aria-live` region.
- Automated: Playwright runs an axe scan (WCAG 2.1 A/AA) of every main screen in light and dark, phone layouts, and
  open dialogs/menus (`e2e/a11y.spec.ts`); serious or critical violations fail the build. Add new screens to it.
- Colour: text colour classes `text-{hue}-600` are remapped in `styles.css` to the nearest shade that passes in each
  theme; avatars use 700 shades. Check new colours with the scan rather than by eye.
- Drag and drop always has a keyboard path: a focusable handle ("Move …"; Space, arrows, Space), never a focusable
  wrapper around links or buttons.

## 9. Text

- Plain, specific words; sentence case; no jargon or internal names ("Couldn't reach the virus scanner", not
  "SCANNER_UNAVAILABLE"). Error messages say what happened and what to do.
- Use the user's terms: Leads, Deals, Contacts, Companies, Products, Invoices, Inbox.

## 10. Before opening a PR

1. Loading, empty, error (and partial) states exist and were seen.
2. Screenshots at 390 / 834 / 1440 in light and dark; no horizontal scroll.
3. Keyboard-only pass of the new flow; axe scan clean.
4. A Playwright test for the flow and API tests for every permission rule.

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

- **Merge duplicates** (contacts, companies): "Merge with…" in the record's ⋯ menu → suggested duplicates (same email,
  phone, website or name) or search → pick which record to keep and, per differing field, which value wins (empty
  fields are filled from the other record by default) → one transaction moves contact details (de-duplicated), deals,
  company/contact links, activities, notes, converted-lead links and the other record's history onto the kept record.
  The other record is soft-deleted with `merged_into_id`; opening its old link offers the kept record; it is not in the
  recycle bin and can't be restored. Needs *Edit* on the kept record and *Delete* on the merged one. Audited as `merged`.

- **Email delivery** (`lib/mailer.ts`): invitations and activity reminders are queued as `email.send` jobs in the same
  transaction as the change and delivered by the worker (3 attempts). Transports: `console` (default; prints to the log),
  `smtp` (nodemailer; used automatically when `SMTP_HOST` is set), `memory` (tests). Settings → Workspace shows the
  delivery status and has "Send a test email to me"; the invite dialog says whether an email went out and always shows
  the link; pending invitations can be re-sent or cancelled; each user can turn reminder emails off in the account menu.
  Credentials come only from the environment (`.env.example` lists the variables, all commented out).

- **Password reset by email**: "Forgot password?" on sign-in → `/forgot-password` → emailed one-time link
  (`/reset-password/:token`, 1 hour, only a SHA-256 hash stored, newest link replaces older ones, max 3 per hour per
  account, 5 requests per 15 min per IP) → new password; all sessions of that user are signed out. The request answers
  the same whether or not the email has an account (no account discovery).

- **Audit log** (Settings → Audit log, admins only): every audit event of the workspace, newest first — who (or
  Automation), which record (linked while it exists, "(deleted)" otherwise), and what happened in the same words as the
  record timeline. Filters: record name, type, action, person, date range; CSV export of the filtered rows (max 10,000).
  Phones get a stacked list instead of the table. Index `audit_workspace_created` (migration 0006).

- **Saved views** on the contacts, companies, leads and deals lists: a bar of chips above the filters ("All" + views).
  A view stores the list's URL filters (search, owner, type/stage/source, sort, board/list — never the page). "Save view"
  appears when the filters don't match a view; the active view's menu renames or deletes it; "Update a view" overwrites
  one with the current filters. Personal views are private (even from admins); shared views (`owner_id` NULL) are visible
  to everyone and only admins create/change them. Max 50 personal views per list. Views only store filters — what a
  person sees is still limited by their role. API: `GET/POST /views`, `PATCH/DELETE /views/:id` (migration 0007).

- **Find duplicates** (`/duplicates/contact|company`, "Find duplicates" on the Contacts and Companies lists): every pair
  of records that share an email, phone, website (normalised) or exactly the same name, strongest matches first (max
  200 pairs). Only records the caller may view are considered. "Merge…" opens the merge dialog on that pair and stays on
  the page; "Not a duplicate" hides the pair for everyone (needs edit on both; audited as `not_duplicate`;
  table `duplicate_dismissals`, migration 0008).

- **CSV export of lists** (Export beside the filters on Contacts, Companies, Leads and Deals; `?format=csv` on the list
  endpoints, `lib/exportList.ts`): exactly the current filters, search and sort, all pages (max 50,000 rows), plus one
  column per custom field (option labels, user names, Yes/No). Needs the role's Export permission and only includes
  records in the export scope; formula-like values are neutralised; every export is in the audit log ("Exported 18
  contacts to CSV", with the filters used).

- **Automation upgrades** (migration 0009): a **"When a field changes"** trigger for deals and leads (built-in fields
  such as amount, owner, close date, probability, description, or any custom field; optionally only while in a given
  stage). Every audited update of a deal/lead emits `deal|lead.field_changed` with the changed fields, so edits from the
  UI, API, imports and other rules all count; the existing depth guard stops rule chains, and a rule may not change the
  field it listens to. **Working-hours delays**: a rule's delay can count working time only, using the workspace time
  zone and working days/hours set in Settings → Workspace (`addBusinessMinutes` in packages/shared handles weekends,
  time zones and daylight saving).

- **Pipeline permissions** (migration 0010, `pipelines.allowed_role_ids`; NULL = everyone): an admin can limit a deal
  pipeline (or the lead pipeline) to chosen roles in Settings → Pipelines ("Who can use it"). The user context carries
  `blockedPipelineIds`; `scopeWhere` and `canOnRecord` exclude those pipelines, so lists, boards, search, reports, the
  dashboard and exports follow automatically. Explicit filters were added where queries bypass them (activity link titles
  show "Restricted deal", related deals on contact/company pages and timelines, the default-pipeline choice), and
  creating, moving or editing into a blocked pipeline is refused. Admins and automation always have access.
  Every permission check on deals/leads must load `pipeline_id` with the row (see tests in `pipeline-access.test.ts`).

- **Multi-currency reporting** (migration 0011: `exchange_rates`, SQL function `crm_to_base`): admins enter rates in
  Settings → Currencies (1 unit = x base currency, valid from a date; same day replaces). Every money sum — dashboard
  KPIs, pipeline-by-stage, won/lost trend, list totals, board columns, reports — converts with the newest rate valid on
  the day (today for open deals, the close date for won/lost). Amounts without a rate are left out (never added in the
  wrong currency) and the dashboard/reports show which currencies need a rate. Records keep their own currency;
  `lib/currency.ts` (`inBase`, `dealInBase`, `missingRates`) is the only way new sums should be written.

- **File attachments** on leads, deals, contacts and companies (migration 0012, `routes/attachments.ts`,
  `lib/files.ts`): a "Files" card on each record page — add by button or drag-and-drop, download, preview images,
  delete. Stored on disk under `FILES_DIR` (default `./data/files`, gitignored, outside the web root) with
  server-generated keys; max `FILES_MAX_BYTES` (10 MB) per file and 100 files per record. Upload/delete need edit rights
  on the record, viewing needs view rights (pipeline restrictions included). Downloads are always `attachment` with
  `nosniff` and a sandbox CSP; only PNG/JPEG/GIF/WebP may be shown inline (never SVG/HTML). Added/removed files are in the
  record history. Merging moves files to the kept record; purging a record deletes its files. Back up `FILES_DIR` with the
  database. The `FileStore` interface is where S3-compatible storage would plug in.

- **Webhook action** for automation (migration 0013, `lib/webhooks.ts`): "Call a webhook" POSTs a signed JSON payload
  (record type, id, title, amount, currency, status, stage, owner, link) when a rule fires. Admins keep an allow-list of
  hosts and a signing secret in Settings → Automation → Webhooks (`/settings/webhooks`, stored in
  `workspaces.settings.webhooks`, never returned by other endpoints). Header `X-CRM-Signature: sha256=<HMAC-SHA256(secret,
  body)>`, plus `X-CRM-Event` and `X-CRM-Delivery` (the run id, for de-duplication). SSRF rules: https only, host on the
  allow-list, no IP literals or credentials in the URL, every resolved address must be public, no redirects, 10 s timeout.
  The call runs outside any DB transaction; failures retry through the job queue (3 attempts) and then mark the run
  failed with the reason. `WEBHOOK_ALLOW_HTTP` / `WEBHOOK_ALLOW_PRIVATE` relax this for local development only and are
  ignored when `NODE_ENV=production`. The connection is pinned to the checked addresses (see "Webhook hardening").

- **Quotes and invoices with PDF** (migration 0014, `routes/documents.ts`, `lib/pdf.ts`, `lib/documentPdf.ts`): a
  "Quotes & invoices" card on each deal creates a draft from the deal's products (or an invoice from an accepted quote).
  Drafts are editable (bill-to, valid-until/due date, notes, items; totals computed on the server with `calcTotals`).
  Statuses: quote draft → sent → accepted/declined (declined → sent again); invoice draft → sent → paid/void. The number
  (`Q-0001`, `INV-0001`, prefixes in Settings → Quotes & invoices) is taken from `document_counters` when a document is
  first sent, so deleted drafts leave no gaps; sent documents are locked and invoices are voided, never deleted.
  Permissions follow the deal (view to see/download, edit to change), incl. pipeline restrictions; status changes are in
  the deal history. PDFs come from a small built-in writer using the standard Helvetica fonts for Latin-1, € and
  typographic quotes, plus an embedded Unicode font for Khmer (see "Khmer in PDFs" below); currencies whose symbol
  can't be drawn use the ISO code (VND 1,000).

- **Field-level permissions** (migration 0015, `roles.field_rules`, `lib/fieldAccess.ts`): in Settings → Roles → Field
  access an admin sets, per role and record type, standard fields to **Read-only** (`LOCKABLE_FIELDS` in shared) and
  custom fields to **Read-only** or **Hidden**. Standard fields can't be hidden on purpose: totals, boards, reports and
  search are built from them. Read-only is enforced on every write path that changes the value (create — empty or the
  server default is allowed —, update, stage moves with custom values, products for a locked amount, import rows, merge
  choices, lead conversion values typed in the dialog); unchanged values pass, so forms work. Hidden custom fields are
  removed from record responses (one `preSerialization` hook on deal/lead/contact/company routes), `/meta` field
  definitions, history/timeline changes (an update that only touched hidden fields disappears), CSV exports, the merge
  preview and import mapping. Admins and automation are never restricted. Automation message templates only offer
  {{title}}, {{amount}} and {{owner}}, so they can't reveal hidden fields.

- **Import deals and products** (migration 0016): Deals → Import and Products → Import use the same wizard.
  Deals: name, amount, currency, stage (any stage of the chosen pipeline, incl. won/lost), expected close, probability,
  company (found by name, created when "Create missing companies" is on), contacts (linked by email or unique full name,
  never created), deal type, source, description, owner; matched by title (only deals the user may see); updating adds
  the file's contacts to the deal. Products: name, SKU, price, currency, unit, tax %, tax included, category, active,
  description; matched by SKU, then name; no owner (access = the role's product scope). Deals and products are written
  through the same functions as the API (`createDeal`/`updateDeal`, `createProduct`/`updateProduct` — products now get
  audit entries too), so validation, required fields, pipeline restrictions and field permissions apply.
  **Add missing list values** (admins only, option `addMissingOptions`): unknown values in list columns (types, source,
  industry, size, deal type, product category) are created instead of failing the row; the review shows how many.

- **Merge follow-ups** (migration 0017): **leads** can be merged (lead page → ⋯ → Merge with…, and a Leads tab on the
  duplicates page; converted leads can't be merged; products move only when the kept lead has none). **More than two at
  once**: the merge window has "Add another …" (up to 10 records); `POST /merge/:entity` takes `mergedIds` and a
  per-field choice by record id (`mergedId` and 'survivor'/'merged' still work). **Similar names** on the duplicates page:
  `crm_person_key` / `crm_company_key` (lower case, punctuation removed, company legal forms like Ltd/Inc dropped) with
  trigram indexes; "Same name" compares the keys, "Similar name" uses `%` at similarity ≥ 0.6 and ranks below shared
  contact details. Field permissions apply to every merged field.

- **Email follow-ups** (migration 0018): **sender name** per workspace (Settings → Workspace → Email delivery; stored
  in `workspaces.settings.emailSenderName`): mails of that workspace go out as `"<name>" <configured address>`, the
  address never changes (SPF/DKIM stay valid) and the name is cleaned so it can't add headers. **Daily summary**:
  `sendDigests()` (worker, every 5 minutes) emails each active member, once per workspace-local day after 08:00, the list
  of their overdue open activities (none → no email); `memberships.digest_sent_on` makes it at-most-once; opt-out in the
  account menu (`email_digest`); titles of deals/leads in pipelines the member may not use show as "Restricted".
  **Failed deliveries**: email jobs carry `workspace_id`; admins see failed ones (recipient, subject, error — never the
  body) under Email delivery and can **Retry**; entries go with the job clean-up after 14 days. Password-reset mails have
  no workspace and are not listed.

- **Invoices: list, payments, email** (migration 0019): sidebar **Invoices** (`/documents`) lists every quote and
  invoice of deals the user can see, with tabs (Unpaid, Overdue, Paid, Quotes, Drafts), search, and Outstanding /
  Overdue totals in the base currency (missing exchange rates are named). **Payments** (`document_payments`,
  `documents.paid_amount`): record partial payments (amount ≤ balance, date, method, note); covered → `paid`, removing
  a payment reopens it; "Mark as paid" records the remaining balance; invoices with payments can't be voided; the PDF
  shows Paid / Balance due. **Email**: `POST /documents/:id/email` sends the PDF as an attachment to up to 5 recipients
  (suggested: the deal's contact/company emails), Reply-To the sender, From the workspace sender name; emailing a draft
  issues it first. Money arithmetic via `moneyMinus` / `moneyCompare` in shared `money.ts`.

- **Attachments: virus scanning and S3 storage** (`lib/virusScan.ts`, `lib/s3.ts`): with `CLAMAV_HOST` set, every upload
  is streamed to ClamAV (clamd INSTREAM) after the permission check; a flagged file is refused (422, `file_blocked` in the
  record history) and an unreachable scanner refuses uploads (503, fail closed). `FILES_STORAGE=s3` stores attachments in
  any S3-compatible service (AWS, MinIO, R2, B2, Spaces) via a small AWS Signature V4 client — no SDK; credentials only
  from `S3_*` environment variables. Admins see the storage and scanning status under Settings → Workspace → File storage.
  Moving existing files from disk to S3 is a one-off copy of `FILES_DIR` into the bucket (same keys).

- **Webhook hardening** (migration 0020): the host is resolved once, every address checked, and the connection is made
  only to those checked addresses (custom `lookup` on Node's http/https request; TLS still verifies the host name) — the
  DNS-rebinding window is closed. Every attempt (automation run, each retry, test send) is logged in
  `webhook_deliveries` (status, error, duration; 30 days) and shown in the rule editor under "Recent deliveries", with a
  **Send test** button that posts a sample record (`*.test` event). Admin only.

- **Locked fields in "New …" forms**: the lead, deal, contact and company create forms leave out fields that are
  read-only (or hidden) for the user's role, including custom fields, so a restricted user is never offered a field the
  server would refuse; the record is created with those fields empty or at their default (e.g. owner = yourself).
  Required fields (deal name, company name) always stay.

- **Import: products on deals, new custom options** (migration 0021): Deals → Import → "Products on existing deals"
  (import type `deal_line`): each row adds one product line to an existing deal, found by Deal name (unique among the
  deals you can see) or Deal ID; products by SKU or name (catalogue price/unit/tax as defaults; unknown products are
  free-text lines and need a unit price); quantity, unit price, discount %, tax %. Uses the role's deal import permission
  plus edit rights on each deal; a locked deal amount (field permissions) refuses the rows. Deal amounts in "auto" mode
  are recalculated; Undo removes the added lines. "Add values that aren't in the lists yet" (admins) now also adds
  options to custom select / multi-select fields (stable id from the label; audited as `option_added`).

- **Undo merge; lead products combined** (migration 0022, `merge_snapshots`): every merge stores what it changed (the
  kept record's fields, all contact details and link rows as they were, the ids of every moved row). "Undo merge" (toast
  right after merging, and a banner on the kept record) restores the merged records and moves exactly those rows back;
  available for 7 days while the kept record hasn't been edited since (anything added to it after the merge stays).
  Needs the same rights as merging. Merging leads now adds the other lead's products, except products the kept lead
  already has (same catalogue product or same name).

- **Khmer, Thai, Lao and extended Latin (Vietnamese) in PDFs** (`lib/pdfFonts.ts`, `lib/fontSubset.ts`,
  `apps/api/assets/fonts/`): text Helvetica can't draw is split into runs per script, shaped with HarfBuzz
  (`harfbuzzjs`, WebAssembly) and drawn with embedded **Noto Sans Khmer / Thai / Lao** and **Noto Sans** (Latin,
  Greek, Cyrillic) Regular/Bold (SIL Open Font License, `assets/fonts/OFL-*.txt`), so subscripts, vowel signs and tone
  marks stack and reorder correctly. A string that contains Latin letters Helvetica lacks (Vietnamese ư ơ ạ ế…) is
  drawn entirely in Noto Sans so words aren't stitched from two typefaces; plain Latin-1 text stays Helvetica.
  **Fonts are subset**: only the drawn glyphs are embedded (hb-subset from harfbuzzjs' WebAssembly, glyph ids kept,
  `ABCDEF+` subset name tags), so a Khmer or Vietnamese invoice is ~15–30 KB instead of 70–450 KB. Latin-only PDFs
  embed nothing (~2–3 KB). Copy & search use `/ActualText` with the original text, plus a ToUnicode map. Khmer, Thai
  and Lao are written without spaces and wrap at word boundaries (`Intl.Segmenter`). Chinese/Japanese/Korean still
  print as "?" (their Noto fonts are 10+ MB CFF fonts — they'd need FontFile3 embedding; not added to the repo).

- **Inbox: website chat and Telegram bots** (migration 0023, `routes/inbox.ts`, `routes/channels.ts`,
  `routes/publicChannels.ts`, `inbox/`):
  - **Channels** (Settings → Channels, admins):
    - *Website chat*: a `<script src="…/widget.js" data-key="…">` snippet. The widget (`inbox/widget.js`, plain JS in
      a shadow root, light/dark, phone layout) talks to `/api/v1/public/webchat/:key` (CORS, rate-limited, optional
      allowed-origins list). Visitors keep a random token in their browser; only its SHA-256 is stored.
    - *Telegram bot*: paste the @BotFather token. It is checked with getMe and stored AES-256-GCM-encrypted
      (`lib/secrets.ts`, `SECRETS_KEY`), never returned by the API. With an https `APP_URL` the CRM registers a webhook
      (`/api/v1/hooks/telegram/:key`, verified by Telegram's secret header); otherwise the worker polls `getUpdates`
      every 3 s (row-locked, so two workers never read the same updates). Private chats and groups the bot is in;
      photos/files/stickers/locations show as "[Photo] caption" etc.
  - **Inbox page** (`/inbox`): open/closed, everyone/mine/unassigned, search (names, usernames, emails, message text);
    thread with replies (Enter sends), assignee, close/reopen, link a contact/lead, "Create contact" (name, email, phone,
    Telegram username). Updates arrive live (see "Live Inbox" below); sidebar badge = open conversations with unread
    messages. Linked conversations show on contact and lead pages.
  - **Delivery**: website replies are read by the widget directly; Telegram replies go through job `inbox.send`
    (3 attempts; "bot blocked"/"not in group" fail at once with Telegram's reason, with a Retry button).
  - **Rules**: new role entity `conversation` (View = read, Edit = reply/assign/close/link), scoped by **assignee**,
    with unassigned conversations visible to everyone who has the permission so they can be picked up. Built-in roles:
    Manager all, Sales rep team, Viewer view-only. Replying to an unassigned conversation assigns it to you; new
    messages reopen closed conversations and notify the assignee (once per unread conversation). Website visitors who
    give an email matching exactly one contact are linked to it automatically. Deleting a channel deletes its
    conversations; disabling keeps them.
  - **Not included**: personal accounts (Telegram user login, WhatsApp, Messenger), Facebook/Instagram/WhatsApp
    Business, typing indicators.

- **Inbox files** (migration 0024, `message_files`, `inbox/files.ts`): incoming Telegram photos (largest size),
  documents, audio, voice notes and videos are downloaded by job `inbox.fetch_file` (getFile + file URL) into the same
  storage as record attachments (disk/S3, ClamAV scan when configured). The Bot API only serves files up to 20 MB, so
  larger ones (or over `FILES_MAX_BYTES`) are listed as "too large — open it in the app"; blocked/failed downloads say
  so too. Agents attach one file per reply (paperclip; caption optional): Telegram gets images via sendPhoto, other
  files via sendDocument (captions over 1,024 characters follow as a separate message); website visitors see images
  inline and other files as links, downloadable only with their own chat token. Downloads (`GET /inbox/files/:id`)
  follow the conversation's view permission and use the attachment download headers (inline only for raster images,
  sandboxed). Deleting a channel removes its stored files.

- **Live Inbox** (`inbox/events.ts`, `GET /inbox/events`, `features/inbox/live.ts`): every change to a conversation
  (new message, reply, delivery result, downloaded file, assignment, read) runs `pg_notify('inbox', …)` in its
  transaction. Each API process keeps one `LISTEN` connection and forwards "conversation N changed" over server-sent
  events to users who may see that conversation (same assignee scope as the API; other workspaces never hear about
  it). Browsers then refetch through the normal API. Works across processes (the separate worker's changes arrive
  too). While the stream is open the Inbox polls only once a minute; if it drops, polling falls back to 4–5 s and the
  browser reconnects. Streams end after 30 minutes and reconnect, which also picks up role changes. Behind a reverse
  proxy, keep `/api/v1/inbox/events` unbuffered (the response sends `X-Accel-Buffering: no` for nginx).

- **Saved replies** (migration 0025, `routes/savedReplies.ts`, `features/inbox/SavedReplies.tsx`): a button in the
  reply box lists saved replies (search, insert, new/edit/delete). `{{first_name}}`, `{{name}}` (the customer) and
  `{{agent}}` (you) are filled in on insert (`fillPlaceholders` in `@crm/shared`). Personal replies are only seen by
  their owner (not even admins); shared "Team" replies are seen by everyone with Inbox view, and only admins share or
  change them. Creating needs Inbox edit.

- **Files from website visitors** (`POST /public/webchat/:key/files`): a paperclip in the chat widget sends a photo or
  PDF. Accepted only when the content really is PNG/JPEG/GIF/WebP/PDF (checked from the file's first bytes, and it
  must match the declared type), up to 5 MB (or `FILES_MAX_BYTES` if lower), 10 uploads a minute per address and 20
  files per conversation a day; virus-scanned when ClamAV is configured. A file can start a conversation. The team sees
  it like any incoming file; the visitor can open their own files with their chat token.

- **UI rules and feed lists** (`docs/UI-RULES.md`, `components/ui/FeedList.tsx`, `feedQuery`/`feedResult` in
  `lib/list.ts`): written rules for every screen (tokens, components, tables & pagination, feeds, forms, states,
  accessibility, checks before a PR). Feeds (newest first) use an opaque cursor of microseconds + id, so rows with equal
  times are neither skipped nor repeated, and `FeedList` shows loading / error / empty / "Load more". The Inbox list and
  the "Conversations" card on contacts and leads use it (no more silent 50-row cap). Also paged with "Load more": record
  history (notes, finished activities and changes merged under one (time, source, id) cursor; the Notes / Activities /
  Changes filter runs on the server), the recycle bin (cursor over (time, table, id)), notifications, import history and
  Inbox threads ("Load older messages", 50 at a time). The short logs keep a fixed size and say so (webhook deliveries
  and failed emails: the 50 most recent); CSV exports state their row limits.

- **Accessibility** (`e2e/a11y.spec.ts`, `@axe-core/playwright`): axe scans (WCAG 2.1 A/AA) of every main screen in
  light and dark, phone layouts and open dialogs/menus; serious or critical violations fail CI. Fixed in this pass:
  text contrast (muted grey `#5b6779`; `text-*-600` remapped per theme in `styles.css`; 700-shade avatars and green
  buttons; brand links lightened in dark mode), the search button's name, and the deal/lead board: cards are no longer
  a focusable wrapper around links (a "Move …" grip button is the keyboard handle) and the arrow keys jump between
  stage columns and the Won/Lost zones (before, keyboard moving only nudged the card 25px and never reached a column).

- **Gaps closed after a user-flow audit** (every API route checked against the UI, journeys walked to their end):
  **Your account** (Settings → Your account, also in the avatar menu): change your name; change your password with
  the current one (other sessions are signed out, this one stays; rate-limited). **Product categories** are managed in
  Settings → Lists & options (deleting one keeps its products). **Custom fields** can be moved up/down (the order
  records and forms use). **Automation** card on deals and leads: what rules did or will do, with failure reasons,
  paged; the endpoint now checks access to that record (before, anyone who could view deals could read the runs of any
  deal in the workspace, including private ones and blocked pipelines).

- **Account security emails** (migration 0026, `email_changes`): changing your password emails you a notice (with a
  reset link in case it wasn't you). **Change your sign-in email** in Settings → Your account: needs your password; a
  one-time link (1 hour) goes to the new address, a notice to the old one; opening it (`/confirm-email/:token`, a
  button, so link scanners can't trigger it) switches the email and kills reset links sent to the old address, and the
  old address is told. The answer is the same whether or not the new address already has an account (its owner gets a
  note instead of a link), so the form can't be used to find out which emails are registered.

- **UI review pass** (every screen at 390 / 834 / 1440, light and dark, with realistic data): **addresses** of contacts,
  companies and leads can now be seen and edited on their pages (they were stored and printed on invoices, but no screen
  showed them); related-record lines in History name the record with a link ("on deal Umbrella forklifts"), only when
  the user may see it; tablet: report tabs and the Settings menu wrap instead of cutting words, deals-list cells stay on
  one line; phone: shorter Inbox reply placeholder. A click-through in real Chrome then fixed: the "Sign-in email" card no longer
  gets the saved login autofilled into "New email" (hidden username field, like the password card); empty values show
  one muted "—" on every detail page; report tables keep each cell on one line.
- **Live website chat and typing indicators:** the widget keeps a live connection while open
  (`GET /public/webchat/:key/events?token=`, server-sent events: "messages" → it refetches, "typing" → "Sreng is
  typing…"), polling only every 30 s as a safety net (4 s if the connection fails). Typing is sent at most every 4 s:
  visitors `POST /public/webchat/:key/typing`, the team `POST /inbox/conversations/:id/typing` (needs reply rights).
  The team sees "Grace is typing…" or "Dara is also writing a reply…" under the messages; on Telegram, the bot shows
  "typing…" in the chat. Typing is never stored; it travels on the same `pg_notify('inbox')` channel. Visitor streams are
  capped (5 per conversation, 2,000 per process) and only ever carry the visitor's own conversation.
- **Facebook Messenger, Instagram and WhatsApp** (Meta's official APIs, business accounts only; `inbox/meta.ts`):
  - **Connect** (Settings → Channels): the admin enters the Page ID / Instagram account ID / WhatsApp phone number ID,
    a long-lived access token and the app secret. The API checks them with Meta (and subscribes the Page to the app
    for Messenger) and explains refusals (expired token, wrong id, missing permission). Both credentials are stored
    encrypted (SECRETS_KEY), never returned or written to the audit log; "Update access token" replaces them.
  - **Webhook** `/api/v1/hooks/meta/:key` (shown on the channel with its verify token): GET answers Meta's check;
    POST is accepted only with a valid `X-Hub-Signature-256` (HMAC of the raw body with the app secret). One Meta app has
    one callback URL, so events are routed by account id to channels **of the same workspace** only.
  - **Incoming:** text, photos, videos, audio, documents (downloaded by the jobs queue: Messenger/Instagram from the
    CDN link, WhatsApp through the media endpoint with the token), stickers, locations, contacts, button replies.
    Our own echoes are skipped, retries de-duplicated. Names: from WhatsApp's webhook, or looked up once for
    Messenger/Instagram. A WhatsApp number links the conversation to the one contact with that phone number.
  - **Replies:** text (split at 2,000 / 1,000 / 4,096 characters) and files (Instagram: photos, videos, audio only).
    Meta delivers replies only **within 24 hours** of the customer's last message: the Inbox warns before, and a
    refused reply says why (WhatsApp templates are not supported yet). WhatsApp delivery failures reported later turn
    the message "failed". An expired token marks the channel "Needs attention". Messenger/Instagram show "typing…".
  - Meta only calls https addresses: on a server whose APP_URL isn't https, the channel says so.
  - **WhatsApp templates** (the only messages WhatsApp delivers after the 24-hour window): with the WhatsApp Business
    Account ID on the channel (Settings → Channels; checked with Meta), the Inbox's 24-hour notice offers "Send a
    template": approved text templates (cached 2 minutes; ones with media headers or button values are left out), a
    field per {{n}} blank, a preview, then the message shows in the thread as the customer sees it, marked "Template"
    (`messages.template`, migration 0029). Refusals (template gone, paused, wrong values) are explained.
  - `META_GRAPH_URL` (default `https://graph.facebook.com/v21.0`) is only changed for tests.
- **Telegram personal account** (Telegram's user API / MTProto through GramJS `telegram@2.26.22`; `inbox/telegramUser.ts`):
  - **Sign in** (Settings → Channels → Telegram account, admins): api_id/api_hash from my.telegram.org and the phone
    number → Telegram sends a code to the account → enter it on the channel → the 2FA password if the account has one
    (used once, **never stored**). "Send a new code" if it expired. Each step is stored (channel status `pending`), so it
    works across API processes. The session, api_id/api_hash are encrypted (SECRETS_KEY), never returned or audited.
    Login attempts are limited to 10 a minute per channel.
  - **Privacy defaults:** private chats only (groups are an opt-in setting, enforced by the CRM, not only the driver);
    new conversations are **assigned to the account's owner** (chosen when connecting). Bots, channels and the owner's
    own messages are skipped; what the owner writes from their phone stays on Telegram.
  - **Live connection:** the worker keeps one connection per account (Postgres advisory lock, so only one process
    holds it) and on (re)connect fetches unread messages of the 50 latest chats. Files are downloaded by the job queue.
  - **Replies** as the account (plain text, no Markdown; files; "typing…" while the live connection is up). Refusals
    are explained (blocked, privacy settings, deleted account). If the session ends (terminated on the phone under
    Settings → Devices), the channel shows "Needs attention"; **Reconnect** starts a new sign-in. Deleting the channel
    logs the session out on Telegram.
  - The MTProto client sits behind `TgUserDriver` (`telegramUserGram.ts`); tests and the e2e server use the fake in
    `apps/api/test/fakes/telegramUser.ts`.

- **Video calls in the app** (WebRTC, peer to peer; `calls/calls.ts`, `routes/calls.ts`, `features/calls`, migration
  0030): start one from **+ New → Video call**, the camera button on a **meeting** in Activities, or **Video call** in
  an Inbox conversation (the customer gets "Join our video call: <link>" in that chat). Camera preview, then a grid with
  mute, camera off, **screen sharing**, "Copy guest link", Leave, and "End for everyone" (whoever started it, or an
  admin). **Guests** join at `/join/<token>` with just a name (token stored hashed + encrypted). Up to 6 people (a mesh:
  best for about 4). The server only relays set-up messages (`call_signals` + `pg_notify('calls')`) and tracks who
  is in the call; audio/video go browser to browser and nothing is recorded. Leaving or refreshing doesn't end a call:
  the worker ends calls empty for a minute, timed until the last person left, and the meeting activity is marked done
  with "Video call, 12 min, with Grace, Sreng". Team members may open a call if they may see its meeting/conversation
  (a call on its own: anyone in the workspace with the link). `CALL_ICE_SERVERS` (JSON) sets STUN/TURN servers;
  default Google's public STUN. **Add a TURN server** (e.g. coturn) for people behind strict firewalls or some mobile
  networks — without one, those calls may not connect.

- **KHQR (Bakong) payments on invoices** (`lib/khqr.ts`, `lib/invoiceKhqr.ts`): Settings → Quotes & invoices → KHQR:
  Bakong account ID (name@bank), the name payers see (≤25 plain characters), city, personal or merchant account
  (merchant ID, bank), days a QR stays valid. Every **sent** invoice in **KHR or USD** with money owing shows "Pay with
  KHQR" — on its page (`GET /documents/:id/khqr`) and on the PDF — for the **balance due** (after part payments, only
  the rest). The QR is the EMVCo/KHQR format byte-for-byte as the official Bakong SDK builds it (tests compare with SDK
  output; the printed QR decodes back to the same text), with an expiry banks require for amounts. Payments still need
  recording by hand (method suggestions include KHQR); automatic confirmation would need the Bakong Open API token.
- **Money formatting fix:** amounts with cents always show two decimals ($1,250.50, never $1,250.5).

- **Sales targets** (migration 0031, `routes/targets.ts`, `features/targets`): Settings → Sales targets (admins) sets
  a monthly amount per person and for the whole team, in the base currency, month by month ("Copy October’s targets").
  Progress = deals won in that month, converted like the dashboard’s "Won this month". The dashboard’s **Targets**
  card shows progress bars (green once reached); people see whom their deal permissions allow (reps: themselves,
  team scope: their team, managers/admins: everyone). `GET /targets?month=YYYY-MM`, `PUT /targets` (admins).
- **UI pass (phones):** list and invoice headers fold secondary buttons (Find duplicates, Import, PDF, Preview, Delete
  draft) into a "More actions" ⋯ menu (`HeaderActions`); the stage bar fits all stages instead of cutting the last;
  record pages no longer scroll sideways when a chat preview is long; the invoices summary is two cards across.

- **Customer links for quotes and invoices** (migration 0032, `routes/publicDocuments.ts`, `/d/<token>`): every sent
  quote/invoice gets a link (token stored hashed + encrypted), shown on the document ("Customer link", Copy) and as a
  "View and accept online" / "View and pay online" button in the email. The customer sees the document, downloads
  the PDF, **accepts a quote** (typing their name, optional note) or **declines** it (optional reason) — expired
  quotes can’t be accepted — and pays an invoice by **KHQR** when set up. The first open and every answer notify the
  deal’s owner and the document’s creator and are written to the deal’s history ("accepted online by …").

- **Team notifications on Telegram** (migration 0033, `inbox/teamAlerts.ts`): Settings → Your account → Telegram
  notifications → "Connect Telegram" makes a one-time link (15 min; also shown as a QR to scan with a phone) to the
  workspace’s first active Telegram bot; tapping Start sends "/start <code>" — linked, answered in Telegram, kept out
  of the Inbox. From then on the worker forwards every new in-app notification of that person (assigned chats, quote
  opened/accepted, reminders…) with a link into the CRM. "Turn off" unlinks; blocking the bot unlinks automatically.
  The e2e server now talks to a fake Bot API (`TELEGRAM_API_URL` in playwright.config.ts), never to Telegram.

- **Recurring invoices** (migration 0034, `routes/recurring.ts`): "Repeat…" on an invoice → every 1/2/3/6/12 months
  from a start date, forever or N times; each new invoice is a **draft** to check or **sent by email** (PDF, customer
  link). Dates keep the start day (short months use their last day). The worker (every 10 minutes) catches up missed
  dates; a schedule that can’t run (deal deleted, creator left) pauses with the reason. Pause / Resume (skips dates
  that passed) / Stop on the invoice’s "Repeats" card and in Quotes & invoices → Recurring. The creator is notified
  each time (also on Telegram, #51).

- **Payment reminders** (migration 0036, `routes/reminders.ts`, `features/documents/Reminders.tsx`): Settings → Quotes &
  invoices → *Payment reminders* (off by default): N days before the due date, on it, and up to three "N days after".
  Sent invoices with a balance get them by email to the addresses the invoice was last emailed to (now kept on the
  invoice as `email_to`; older invoices were filled from their "emailed" history) with the PDF and the "View and pay"
  button, and optionally in the Telegram bot chats of the deal's contacts — in the customer language. The worker (every
  10 minutes) sends after 9:00 workspace time, one step per invoice per day, only steps of the last 3 days (turning it on
  doesn't flood old invoices), never the same step twice and never an earlier step after a later one. Paid/void invoices
  and invoices marked "Don't remind for this invoice" get none. The invoice's "Payment reminders" card shows the next
  one, the recipients and what was sent; "Send reminder now" works even with automatic reminders off. Each reminder is
  on the deal's timeline.

- **Online booking** (migration 0037, `routes/booking.ts`, `packages/shared/src/booking.ts`, `features/booking/`):
  Settings → Booking pages (admins create, everyone can copy the links): title, link (`/book/<slug>`), the team member
  customers meet, length (15 min – 2 h), days and hours, notice, days ahead, video call or a place. Customers pick a
  day and a free time (the host's open meetings and calls block times; workspace time zone), enter name/email/phone/note
  and are booked. The booking finds the contact by email or creates one (owned by the host), adds a meeting for the host
  linked to it (15-minute reminder; the host is notified), opens a video call for it on video pages (guest link in the
  meeting's location; planned calls stay open until a day after their time), and emails the customer a confirmation
  in the customer language with a calendar file (.ics) and a link to `/booking/<token>` (join the call, cancel).
  Cancelling cancels the meeting and its call, tells the host and frees the time. **Moving** (migration 0040): on the
  same page, "Pick a new time" shows the free times (their own booking doesn't block nearby ones); the booking, the
  meeting (and its 15-minute reminder) and the video call move, the host is told, the contact's timeline notes it, and
  a new confirmation with the calendar file's SEQUENCE raised replaces the old calendar entry. Up to 3 moves per booking;
  not when the page was turned off or deleted (cancel still works).
  **The team** (admins and the booking's host; migration 0041) can **Move** or **Cancel** a booking from Settings →
  Booking pages → "N upcoming": move to any future time (also outside the page's hours) when the host is free, or
  cancel with an optional message. The customer is emailed ("Rita moved your booking" / "Rita canceled this booking",
  with the message) with their link and a calendar file; the host is told when someone else did it; the contact's
  timeline notes it. Team moves don't count against the customer's 3 moves (the calendar version has its own counter).
  The customer's link is now also kept encrypted, so team emails can include it (bookings made before: no link).
  **Shared pages (round-robin, migration 0042)**: "With" can be several people (`team_ids`; `host_id` stays the first).
  A time is offered when any of them is free; each booking goes to a free one, taking turns (whoever went longest
  without a booking from this page, then the page's order); the meeting, new contact and video call are theirs. The
  customer page says "with <company>". Everyone on the page sees its bookings ("with Rita"). A customer's move stays
  with their person (only their free times are offered); people taken off the page keep their bookings, but those
  customers can't move them any more (cancel still works). The API takes `hostIds` (or the old `hostId`). Bookings for one host are serialised
  (no double booking); at most 3 upcoming bookings per email per page; public endpoints are rate-limited. The contact's
  timeline shows "Booked …" and cancellations; the page's upcoming bookings are listed for admins and the host.

- **Customer feedback** (migration 0038, `routes/feedback.ts`, `features/feedback/Feedback.tsx`): Settings → Customer
  feedback (off by default): N days after a deal is won (0–30; only deals won after it was turned on, within 30 days)
  the worker emails the deal's main contact with an address a link `/r/<token>` to rate 1–5 with an optional comment,
  in the customer language. One request per deal; "Ask now" on a won deal's "Customer feedback" card. Contacts who
  unsubscribed from emails are never asked. The rating counts for the deal owner at the time of asking, who gets a
  notification ("Low rating: 2/5 …" for 1–2). Customers can change their answer for 30 days. Deal timeline entries;
  Home → "Customer rating": average, answered/asked, per person (deal view scope, like sales targets), latest comments.

- **Signing a quote** (migration 0039, `packages/shared/src/signature.ts`, `features/documents/Signature.tsx`): when
  accepting a quote on the customer page, the customer can draw a signature with a finger, pen or mouse; Settings →
  Quotes & invoices → "Customers must sign" makes it required. It's stored as pen strokes (whole numbers in a 300×100
  box, validated: inside the box, not a dot, size limits), shown as SVG to the customer and in the team's "Customer
  link" card (with the signing IP), and drawn as lines on the PDF under "Accepted and signed" with "Signed by … on …".
  Quotes accepted without a signature print "Accepted online by … on …". The signing IP and browser are kept as evidence.
  The timeline's "accepted" entry says whether it was signed. This is a simple electronic signature (typed name +
  drawing + IP), not a certificate-based digital signature.

- **Team performance report** (Reports → Team performance, `teamPerformance()` in `routes/reports.ts`): one row per
  active member the user may see (deal view scope; "Only me" / "My team" narrow it), for the chosen period: deals won
  (and win rate over won + lost), won amount in the base currency, the sum of their monthly sales targets for the months
  in the period and the share reached, activities completed, Inbox replies they wrote (broadcasts excluded), the median
  time a customer waited for those replies (wall-clock, from their first unanswered message; follow-ups with nobody
  waiting don't count), and the average customer rating received (with how many). Totals on top; CSV export (export
  rights) has every column, including the user id and the rating count.

- **WhatsApp reminders and booking confirmations** (migration 0043, `inbox/waNotify.ts`,
  `features/settings/WhatsAppTemplateField.tsx`): payment reminders (Settings → Quotes & invoices) and each booking page
  can also send on WhatsApp: pick a WhatsApp channel, one of its approved templates, and which value fills each {{n}}
  blank (customer name, invoice number, amount due, due date, link, company; for bookings: what was booked, date and
  time), with a preview. It goes to the contact's WhatsApp chat on that channel, else the phone number on the contact
  (a chat is started in the Inbox and linked), else — for bookings — the number typed when booking. It's a normal Inbox
  message (delivery queue, retries, errors on the message). A reminder counts as sendable when WhatsApp can reach
  someone, even without an email; the invoice card shows "1 WhatsApp chat". If the channel is off or Meta withdrew the
  template, WhatsApp is skipped and the email still goes. Booking confirmations go on booking and on every move.
  Because anyone can book, booking messages go **only to the number typed on the booking form** (never to the saved
  numbers of a contact matched by email), at most **3 a day per number** and **100 bookings with a phone a day per
  workspace** (`BOOKING_WA_PER_NUMBER`, `BOOKING_WA_PER_WORKSPACE` in `routes/booking.ts`); over a limit, the booking
  and its email still go, without WhatsApp. Moves made by the team aren't limited.

- **Installable app (PWA)** (`apps/web/public/manifest.webmanifest`, `sw.js`, `offline.html`, `lib/install.ts`):
  add to the home screen (Android, iPhone via Safari → Share → Add to Home Screen) or install on desktop Chrome/Edge;
  opens full-screen with its own icon (192/512, maskable, Apple 180 — rendered from the logo) and shortcuts to Inbox,
  Deals and Activities. The service worker (production builds) keeps `/assets/` files after the first load (they’re
  content-hashed), always fetches pages from the server, shows a friendly offline page without a connection (reloads by
  itself when it’s back), and **never caches /api/** — data is always live and nothing private stays on the device.
  Your account → "App on your phone": install button where the browser offers it, instructions otherwise. Chrome’s own
  installability check reports no errors.

- **Khmer for customers** (`packages/shared/src/customerText.ts`): Settings → Quotes & invoices → *Language for
  customers*: English, ខ្មែរ, or ខ្មែរ + English. It sets every customer-facing text — PDF labels (bilingual column
  headers stack Khmer over English; dates with Khmer month names), the customer page for quotes/invoices, the email
  button, the website chat widget (texts sent with its settings; English built in as fallback) and the guest video-call
  page. The team’s screens stay English. **All wording lives in one file — have a native speaker review the Khmer.**

- **Broadcasts** (migration 0035, `routes/broadcasts.ts`, `features/broadcasts/Broadcasts.tsx`; admins only, sidebar
  → Broadcasts): one message to many customers. **Telegram bot**: text to everyone who chatted with the bot privately
  (groups left out). **WhatsApp**: an approved template only (Meta allows nothing else outside the 24-hour window);
  blanks can use `{{first_name}}`. **Email**: subject + text to contacts with an address (optionally one contact
  type), one email per address, with an unsubscribe link in the footer and `List-Unsubscribe` / one-click
  `List-Unsubscribe-Post` headers. Messenger/Instagram (Meta forbids marketing), the personal Telegram account (bulk
  sending gets accounts banned) and website chat are deliberately not offered. `{{name}}` / `{{first_name}}` are
  filled per person; the editor shows the audience count, opted-out count and a preview. Send now or schedule; the
  audience is fixed when sending starts; the worker sends 200 per round per broadcast through the normal delivery
  queue (chat messages appear in each conversation, without moving it to the top of the Inbox). Progress page:
  delivered / failed / still sending, the list of people (paged, "Failed" filter with the platform’s reason); Stop
  while scheduled or sending. Sent broadcasts stay as a record (no edit/delete).
  **Opt-out:** a chat message that is only `STOP` / `/stop` / `unsubscribe` / `ឈប់` marks that conversation opted out
  and answers in the customer language; `START` undoes it. The email link opens `/unsubscribe/<token>`, which asks
  before unsubscribing (mail scanners open links) and offers "Subscribe again"; it marks every contact with that
  address. Tokens are random, stored only as SHA-256 hashes; the page shows the address partly masked.
  **On the contact page** (`routes/contactMarketing.ts`, `ContactBroadcasts.tsx`): a "Broadcasts" card shows whether
  the contact gets broadcast emails and each linked Telegram/WhatsApp chat (only chats the user may see), and the last
  10 broadcasts they received. People who may edit the contact can record an opt-out the customer asked for, or undo
  one at their request (the email choice covers every contact with the same address). Every change — the customer’s
  STOP/START or link, or a team member — is on the contact’s timeline.

**Quality:** 278 Vitest tests (API against real PostgreSQL), 80 Playwright tests (desktop, tablet, phone), lint and
typecheck clean, `npm audit` = 0, GitHub Actions CI in `.github/workflows/ci.yml`.

## 3. Not built yet — suggested next work (in priority order)

The earlier list is done (see section 2). Known follow-ups, collected from the pull requests' "not verified" notes:

1. PDFs: Chinese/Japanese/Korean if needed — Noto Sans CJK is a CFF (OpenType/PostScript) font of 10+ MB per weight:
   it would need `FontFile3`/`CIDFontType0` embedding next to the TrueType path, and the font kept outside the repo
   (subsetting already exists). Other scripts with TrueType Noto fonts are one line in `SCRIPTS` (`lib/pdfFonts.ts`).
2. (Checked 2026-11-18: copying Khmer from our PDFs in Chrome's PDF engine, PDFium, gives exactly the original
   text; the repeated fragments seen earlier were a MuPDF extraction quirk. Acrobat not checked.)
3. Inbox, Telegram account: try it with a real account (only the fake driver has run; the GramJS driver is
   type-checked against GramJS). Unofficial WhatsApp-Web libraries break WhatsApp's terms and get numbers banned; Meta
   has no API for personal Messenger/Instagram inboxes, so those stay out.
4. Inbox, Meta: test against Meta itself with a real app (only a fake Graph API has been used so far); templates with
   media headers or values in buttons.
5. Video calls: a TURN server for strict networks; recording; more than ~4 people would need a media server (SFU, e.g.
   LiveKit or mediasoup).
6. Broadcasts: only fake Telegram/Graph APIs and the mail queue have been used. Before large sends, check the
   platforms' limits (Telegram ~30 messages/second per bot; WhatsApp tiers by number quality) and the SMTP provider's
   bulk-mail rules (SPF/DKIM/DMARC for the sending domain).
7. Payment reminders: they stop when an invoice is paid in the CRM — record bank payments promptly. WhatsApp uses one
   template language per workspace/page (no per-customer language choice yet); cancellations aren't sent on WhatsApp.
8. Booking: no sync with Google/Outlook calendars (only CRM meetings block times); round-robin takes turns but doesn't
   weigh people (e.g. "Rita gets twice as many");
   editing a booked meeting directly in Activities doesn't update the booking or email the customer (use Move).
9. KHQR: confirm payments automatically through the Bakong Open API (needs a token from the NBC); scan a printed QR
   with a real bank app before relying on it.

Writing API tests: all test files share one database and run one after another, so the job queue can hold jobs left
by earlier files. To run queued work (emails, Inbox sends, automation, file downloads) use `drainJobs()` from
`apps/api/test/helpers.ts` — it runs the outbox and jobs until nothing is due — never a single `processJobs()`.

Import limits and choices: 5 MB / 10,000 rows / 100 columns per file; lead rows only match *open* leads; list
values (type, source, industry, size, deal type, category) must already exist unless an admin ticks "Add values that aren't in
the lists yet"; deal contacts must already exist; "Undo" does not revert updates; raw cells are kept 30 days.

Email choices: reminder emails and the daily summary use the workspace time zone; a failed delivery is retried twice,
then listed for admins under Settings → Workspace → Email delivery (Retry; kept 14 days) — the in-app notification is
unaffected; invitation links are never written to the server log.

Merge choices: a merge can be undone for 7 days while the kept record is unchanged (after that, the losing values
are only in the audit event); private records can be merged only by people who may see both.

Fixed in the merge PR (were "small known gaps"): Activities now opens on the first non-empty tab (Overdue → Today →
Upcoming); dashboard chart colours follow a theme switch without a reload.

## 4. Project map

```
apps/api/src
  app.ts            Fastify setup: cookies, helmet/CSP, rate limit, CSRF + session hook, error handler, SPA static serving
  server.ts         Migrates, starts HTTP, runs the background worker inline (INLINE_WORKER=false to disable)
  worker.ts         Standalone worker entry
  config.ts
  db/               pool.ts (pg + type parsers), sql.ts (tagged-template builder), migrate.ts, migrations/*.sql, seed.ts
  lib/              mailer (email transports + templates), auth, permissions, audit, events (outbox), list (search/sort/paging), customFields, contactMethods,
                    records (insert/update helpers, camelCase), stages (stage changes), bootstrap (workspace defaults)
  imports/engine.ts CSV import: row → input, duplicate matching, preview, chunked runner (job `import.run`)
  routes/           auth, meta, parties (contacts+companies+duplicates), merge, leads, deals, imports, activities (+notes, timeline,
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

### On Windows

Verified on Windows 10 with Git Bash. Everything works natively (the API resolves the web `dist` folder with
`fileURLToPath`, so no `WEB_DIST` override is needed). If another PostgreSQL already listens on 5432, run the project
database on another port and point the URLs at it (`.env` is gitignored; tests read the env vars, not `.env`):

```bash
docker run -d --name crm-pg16 -e POSTGRES_USER=crm -e POSTGRES_PASSWORD=crm -e POSTGRES_DB=crm_dev -p 127.0.0.1:5433:5432 postgres:16
docker exec crm-pg16 psql -U crm -d crm_dev -c "CREATE DATABASE crm_test OWNER crm" -c "CREATE DATABASE crm_e2e OWNER crm"
export DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_dev
export TEST_DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_test
export E2E_DATABASE_URL=postgres://crm:crm@127.0.0.1:5433/crm_e2e
```

Gotchas learned the hard way:
- `pkill -f "<pattern>"` can match your own shell command and kill it; kill by PID instead.
- Background processes in the cloud sandbox are stopped after about 2 hours.
- `npm` commands must run with Node 26 first on PATH (`engine-strict=true`).

## 6. Production

`npm ci && npm run build`, then `NODE_ENV=production DATABASE_URL=… APP_URL=https://… npm start`.
For real email set `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) in the environment; without it messages
are only printed to the log. Check it in Settings → Workspace → "Send a test email to me".
Behind a reverse proxy or load balancer set `TRUST_PROXY` (its address, CIDR list, or hop count) so rate limits see
the real client address; leave it unset when the app is reached directly (otherwise clients can fake `X-Forwarded-For`
and dodge the login and website-chat limits).
One process serves `/api/v1/*` and the built SPA, runs migrations on start and runs jobs inline. Serve over HTTPS
(cookies are `Secure` in production). Health checks: `GET /api/v1/health`.
Set `SECRETS_KEY` (32 random bytes, base64) before connecting Telegram bots: their tokens are encrypted with it, and
without it production refuses to store them. Back it up with the database; if it's lost, reconnect the bots.

## 7. Key business rules (don't break these)

- Every row is scoped by `workspace_id`; tests in `permissions.test.ts` assert isolation.
- A deal's stage must belong to its pipeline; won/lost set `status` and `closed_at`; reopening clears them.
- Leads reach the won stage only through conversion; disqualify = lost stage.
- "Required from stage" = required at the earliest selected stage and every later stage (including won), never on lost.
- Restore from the recycle bin keeps the id. Purge after 30 days.
- Required fields are enforced by the API, not just the UI (Bitrix24 only enforced them in the UI).
- Amounts in `auto` mode always equal the sum of line items.

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

**Quality:** 196 Vitest tests (API against real PostgreSQL), 48 Playwright tests (desktop, tablet, phone), lint and
typecheck clean, `npm audit` = 0, GitHub Actions CI in `.github/workflows/ci.yml`.

## 3. Not built yet — suggested next work (in priority order)

The earlier list is done (see section 2). Known follow-ups, collected from the pull requests' "not verified" notes:

1. PDFs: Chinese/Japanese/Korean if needed — Noto Sans CJK is a CFF (OpenType/PostScript) font of 10+ MB per weight:
   it would need `FontFile3`/`CIDFontType0` embedding next to the TrueType path, and the font kept outside the repo
   (subsetting already exists). Other scripts with TrueType Noto fonts are one line in `SCRIPTS` (`lib/pdfFonts.ts`).
2. Copy & paste of Khmer from PDFs: the file carries the exact text (`/ActualText`), but MuPDF's text extraction
   repeats some fragments where marks step back over a base letter; check in Acrobat / browser viewers.
3. Inbox, next channels (same `channels` / `conversations` / `messages` tables, add a `kind` and an ingest/send pair):
   Facebook Page Messenger and Instagram (Meta Graph API webhooks; needs a Meta app and App Review), WhatsApp Business
   (Cloud API), and a **Telegram personal account** (MTProto user login, e.g. GramJS; the account owner logs in with
   their phone code — needs `api_id`/`api_hash` from my.telegram.org). Unofficial WhatsApp-Web libraries break
   WhatsApp's terms and get numbers banned; Meta has no API for personal Messenger/Instagram inboxes.
4. Inbox: live updates for the visitor's widget (it polls every 4 s while open); typing indicators.

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

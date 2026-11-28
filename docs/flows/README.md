# User flows

The main journeys through the CRM, as they work today. Each diagram names the screen or API behind every step, so
use them to find your way into the code. Keep them current when a flow changes (same PR).

GitHub renders the Mermaid blocks; locally, any Mermaid preview works.

## 1. Lead → deal (qualify and convert)

```mermaid
flowchart TD
  A[New lead: form, import, website chat, booking] --> B[Leads board / list<br/>score Hot·Warm·Cold]
  B --> C{Work the lead}
  C -->|note, call, task| D[Timeline on the lead<br/>raises the engagement score]
  D --> C
  C -->|not a fit| X[Disqualify with a reason<br/>→ lost stage]
  C -->|qualified| E[Convert dialog]
  E --> F{Duplicates found?<br/>same email / phone / name}
  F -->|yes| G[Link to the existing contact/company]
  F -->|no| H[Create new contact/company]
  G --> I[Create the deal<br/>optional; products copied]
  H --> I
  I --> J[One transaction:<br/>lead → won stage, open activities follow, audited]
  J --> K[Deal page / Kanban]
```

`features/leads/ConvertDialog.tsx`, `POST /leads/:id/convert` (`routes/leads.ts`). Leads only reach the won stage by
converting.

## 2. Deal → quote → invoice → paid

```mermaid
flowchart TD
  A[Deal with products] --> B[Quotes & invoices card → new quote draft]
  B --> C[Edit draft: bill-to, valid until, items]
  C --> D[Send by email: number assigned, PDF + customer link /d/…]
  D --> E[Customer opens the link<br/>team notified the first time]
  E --> F{Customer answers}
  F -->|Accept: name + signature if required| G[Quote accepted]
  F -->|Decline with reason| H[Quote declined → can be sent again]
  G --> I[Invoice from the accepted quote]
  I --> J[Send: number, PDF, link with KHQR]
  J --> K{Paid in full?}
  K -->|reminders before / on / after due<br/>email, Telegram, WhatsApp| K
  K -->|payments recorded, partial allowed| L[Balance 0 → paid]
  J -->|cancelled| V[Void — invoices are never deleted]
```

`routes/documents.ts`, `routes/publicDocuments.ts`, `routes/reminders.ts`, `features/documents/*`.

## 3. Import a CSV

```mermaid
flowchart TD
  A[Contacts / Companies / Leads / Deals → Import] --> B[Upload CSV<br/>UTF-8 or Windows-1252, any separator]
  B --> C[Map columns<br/>auto-matched by header, custom fields too]
  C --> D[Options: duplicates skip / update / create,<br/>match by email, phone, name, website; owner]
  D --> E[Dry run: every row previewed with errors]
  E -->|fix mapping| C
  E --> F[Run in the background<br/>chunks of 200, live progress, Stop]
  F --> G[Report: created / updated / skipped / failed]
  G --> H[Download failed rows → fix → import again]
  G --> I[Undo: created records → recycle bin]
```

`features/imports/*`, `imports/engine.ts`. Records go through the same service functions as the forms, so validation,
required fields and the audit log are identical.

## 4. Find and merge duplicates

```mermaid
flowchart TD
  A[Record ⋯ → Merge with…<br/>or Find duplicates on the list] --> B[Suggested matches<br/>same email, phone, website or name]
  B -->|Not a duplicate| N[Pair hidden for everyone]
  B --> C[Pick the record to keep]
  C --> D[Per differing field: which value wins<br/>empty fields filled from the other]
  D --> E[One transaction: details, deals, links, activities,<br/>notes and history move to the kept record]
  E --> F[Other record soft-deleted with merged_into<br/>old links point to the kept one]
  F --> U[Undo for 7 days while the kept record is unchanged]
```

Needs Edit on the kept record and Delete on the merged one. `routes/merge.ts`, `routes/duplicates.ts`.

## 5. A customer books a meeting

```mermaid
flowchart TD
  A[Public page /book/slug] --> B[Free times<br/>host calendars, working hours, notice]
  B --> C[Name, email, phone, note]
  C --> D{Time still free?}
  D -->|no| B
  D -->|yes| E[Host: the page's person, or round-robin<br/>furthest below their share]
  E --> F[Contact found by email, or created]
  F --> G[Meeting activity + video call link if on]
  G --> H[Confirmation email with calendar file<br/>WhatsApp only to the typed number, daily limits]
  H --> I[Manage link /booking/token]
  I -->|Reschedule: a few times, before it starts| B
  I -->|Cancel before it starts| X[Host told; meeting and call cancelled]
```

`routes/booking.ts`, `features/booking/*`.

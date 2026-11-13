# Prompt for the next agent

Copy everything inside the box below into a new Claude Code session that has the `crm_template` repository attached.
Edit the "Your task" section to pick what to build next.

---

```text
You are continuing development of "Acme CRM", a full-stack CRM in this repository (crm_template).
Act as a senior full-stack engineer, product designer and QA engineer.

START HERE
1. Read CLAUDE.md (working rules) and docs/HANDOFF.md (status, project map, setup, business rules).
   Skim docs/CRM_UX_REDESIGN.md before touching any UI, and docs/DATABASE_SCHEMA.md before touching data.
2. Set up the environment exactly as docs/HANDOFF.md section 5 describes (Node 26 LTS, PostgreSQL 16,
   databases crm_dev / crm_test / crm_e2e), then run every check and confirm they are green BEFORE changing code:
     npm ci && npm run typecheck && npm run lint && npm test
     npm run build && npm run e2e        (PW_CHROMIUM_PATH=/opt/pw-browsers/chromium if preinstalled)
     npm audit                           (must be 0 vulnerabilities)
   If anything fails before you change code, report it first.

YOUR TASK
Implement the next items from docs/HANDOFF.md section 3, in order, one pull request per item:
  1. CSV import for contacts, companies and leads (upload, column mapping, preview, duplicate handling, result report).
  2. Merge duplicate contacts/companies (re-point deals, activities, notes, contact methods; audit the merge).
  3. Pluggable email delivery for invitations and reminders (console transport in dev, SMTP in prod via env vars).
(Replace this list with whatever the owner asks for.)

HOW TO WORK
- Work on a feature branch; open a pull request into main; never push directly to main.
- Follow the existing patterns: zod schemas in packages/shared, `sql` tagged templates with workspace_id filters,
  scopeWhere/assertOnRecord for permissions, audit() on every mutation, shared UI components, camelCase responses.
- New migrations go in a new numbered SQL file; never edit an applied one.
- Use the latest stable LTS/stable versions; keep dependencies minimal and pinned; npm audit must stay at 0.
- Every feature needs: API integration tests (including permissions and workspace isolation), Playwright e2e for the
  main user flow, loading/empty/error states, and a visual check at 390px, 834px and 1440px (light and dark).
- No decorative buttons: everything visible must work.
- Do not store secrets or credentials in the repository.
- Keep docs/HANDOFF.md and the other docs up to date with what you changed.
- When done with each item: all checks green, summarise what changed, what was tested and anything not verified.

Demo login after `npm run db:seed`: demo@example.com / demo12345.
```

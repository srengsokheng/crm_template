# Prompt for the next agent (self-contained)

## Before you paste it (owner, one time)

1. On GitHub, open https://github.com/srengsokheng/crm_template → **Settings → Collaborators** → add the other
   GitHub account (Write access). Accept the invite from that account.
2. **Settings → General → Default branch** → choose `main`.
3. In the other Claude account: claude.ai → Settings → Connectors → connect GitHub with that GitHub account, and make
   sure the Claude GitHub app can access `srengsokheng/crm_template`.
4. Start a new Claude Code session (claude.ai/code) with the repository `srengsokheng/crm_template` selected, branch
   `main`. Then paste everything inside the box below.

---

```text
You are taking over an existing project: "Acme CRM", a full-stack CRM web application.
Act as a senior full-stack engineer, product designer and QA engineer. Work carefully and verify everything.

=== 1. THE REPOSITORY ===
- GitHub: https://github.com/srengsokheng/crm_template   (owner: srengsokheng)
- Main branch: main  (everything so far is merged there)
- If the repository is not already checked out in this session, attach/clone it:
    git clone https://github.com/srengsokheng/crm_template.git && cd crm_template
  If access is denied, stop and tell me — I need to add your GitHub account as a collaborator.
- Never push directly to main. Create a branch per task (e.g. feat/csv-import), push it, and open a pull
  request into main. Only merge when every check is green and I say so.

=== 2. READ THESE FIRST (in this order) ===
1. CLAUDE.md                     – working rules and conventions (mandatory)
2. docs/HANDOFF.md               – current status, project map, setup, business rules, next work
3. docs/CRM_UX_REDESIGN.md       – design principles and tokens; follow them for every screen
4. docs/DATABASE_SCHEMA.md       – data model and service rules
5. docs/CRM_ARCHITECTURE.md      – architecture; see the "As built" table at the top
Background research (read when relevant): docs/BITRIX24_ANALYSIS.md, docs/CRM_WORKFLOWS.md, docs/CRM_FEATURES.md,
docs/IMPLEMENTATION_PLAN.md. The product was designed by studying Bitrix24 and simplifying its UX.

=== 3. WHAT ALREADY EXISTS (all working and tested) ===
Stack: Node.js 26 LTS (API runs TypeScript directly), React 19 + Vite 8 + Tailwind CSS 4 + Lucide,
Fastify 5 + zod 4, PostgreSQL 16 with hand-written SQL migrations, Vitest + Playwright, GitHub Actions CI.
Monorepo (npm workspaces): apps/api, apps/web, packages/shared, e2e/, docs/.
Features: auth & workspaces with invites; contacts & companies; leads with conversion to contact/company/deal;
deals with multiple pipelines, Kanban drag-and-drop, won/lost with reasons, undo, line items; activities,
reminders and notifications; unified timeline and field-level history; products; custom fields (required always
or from a stage onward); roles with own/team/all scopes, teams, private records; automation rules with delays;
dashboard and 8 reports with CSV export; recycle bin (restore keeps ids); responsive layouts and dark mode.
Quality: 33 API/unit tests, 10 Playwright browser tests, lint and typecheck clean, npm audit = 0.

=== 4. SET UP AND VERIFY BEFORE CHANGING ANYTHING ===
Follow docs/HANDOFF.md section 5. In a Claude Code cloud container (no Docker) that is:
  # Node 26 LTS (the image usually has Node 22)
  V=v26.13.0; F=node-$V-linux-x64.tar.xz
  curl -sSfO https://nodejs.org/dist/$V/$F && curl -sSfO https://nodejs.org/dist/$V/SHASUMS256.txt
  grep " $F\$" SHASUMS256.txt | sha256sum -c - && mkdir -p /opt/node26 && tar -xJf $F -C /opt/node26 --strip-components=1
  export PATH=/opt/node26/bin:$PATH        # run every npm/node command with this PATH
  # PostgreSQL 16
  service postgresql start
  su postgres -c "psql -c \"CREATE ROLE crm LOGIN PASSWORD 'crm' CREATEDB;\""
  su postgres -c "createdb -O crm crm_dev; createdb -O crm crm_test; createdb -O crm crm_e2e"
  # Project
  cp .env.example .env
  npm ci
  npm run typecheck && npm run lint && npm test
  npm run build && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e
  npm audit
(On a normal machine: install Node 26, run `docker compose up -d db`, create crm_e2e, then the same npm commands.)
Report the results. If anything fails BEFORE you changed code, tell me first instead of working around it.

To look at the app: `npm run db:migrate && npm run db:seed && npm run dev`, open http://localhost:5173,
sign in as demo@example.com / demo12345 (teammates dara@, mia@, omar@example.com use the same password).

=== 5. YOUR TASK (continue from here) ===
Build the next items from docs/HANDOFF.md section 3, one branch + pull request each, in this order:
  1. CSV import for contacts, companies and leads: upload, column mapping, preview, duplicate handling
     (skip / update / create), result report with row errors.
  2. Merge duplicate contacts and companies: choose the surviving record and field values, re-point deals,
     activities, notes and contact methods, keep history, audit the merge.
  3. Pluggable email delivery for invitations and activity reminders (console transport in development, SMTP in
     production configured by environment variables; never commit credentials).
After each item, stop, summarise, and wait for my go-ahead before starting the next one.

=== 6. RULES ===
- Follow the patterns in CLAUDE.md: zod schemas in packages/shared, `sql` tagged templates that always filter by
  workspace_id, scopeWhere/assertOnRecord for permissions, audit() on every mutation, camelCase API responses,
  shared UI components from apps/web/src/components/ui and apps/web/src/features/records.
- New database changes = a new numbered SQL file in apps/api/src/db/migrations; never edit an applied one.
- Use the latest stable / LTS versions; keep dependencies minimal and pinned; npm audit must stay at 0.
- Every feature needs API integration tests (including permissions and workspace isolation), a Playwright test for
  the main flow, loading/empty/error states, and a visual check at 390px, 834px and 1440px in light and dark mode.
- No decorative buttons: everything shown must work.
- Never store secrets or credentials in the repository.
- Update docs/HANDOFF.md (status + next work) in the same pull request.
- When you report, list exactly what you tested and anything you could not verify.
```

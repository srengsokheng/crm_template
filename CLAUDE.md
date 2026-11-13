# Acme CRM — working rules for agents

Read `docs/HANDOFF.md` first: it explains what exists, how to run it, and what to build next.

## Branches
- `main` is the integration branch. Do work on a feature branch and open a pull request into `main`.
- Never force-push `main`. Only merge when CI (typecheck, lint, tests, build, e2e) is green.

## Toolchain
- Node.js **26 LTS** (`.nvmrc`). The API runs TypeScript directly via Node type stripping, so:
  - relative imports must use the `.ts` extension (`import { x } from './y.ts'`);
  - only erasable TypeScript syntax (no `enum`, no constructor parameter properties, no namespaces).
- PostgreSQL 16+. Migrations are hand-written SQL in `apps/api/src/db/migrations/NNNN_name.sql`, applied in order on start.
  Never edit an applied migration; add a new numbered file.
- Dependencies are pinned exactly (`.npmrc save-exact`). Before adding one, check `npm audit` stays at 0 and prefer
  writing a small helper over pulling a large package.

## Checks (all must pass before pushing)
```bash
npm run typecheck
npm run lint
npm test                        # Vitest: shared unit + API integration tests on TEST_DATABASE_URL
npm run build && npm run e2e    # Playwright (set PW_CHROMIUM_PATH if Chromium is preinstalled)
npm audit                       # must report 0 vulnerabilities
```

## Conventions
- **Validation:** request schemas live in `packages/shared/src/schemas.ts` (zod) and are used by API and web. Parse with
  `parse(schema, req.body)` in routes.
- **SQL:** always use the `sql\`\`` tagged template from `apps/api/src/db` (parameters are bound). `raw()` only for
  identifiers we control. Every query must filter by `workspace_id`.
- **Permissions:** lists use `scopeWhere(ctx, entity, 'view', alias)`; mutations call `assertOnRecord(...)`. Settings
  endpoints call `requireAdmin(ctx)`. Add an API test for every new permission rule.
- **Audit:** every mutation of a CRM record writes `audit(...)`; stage changes go through `recordStageChange(...)`, which
  also emits the outbox event automation listens to.
- **Money:** `numeric(18,2)` in the DB, strings over JSON, arithmetic only via `packages/shared/src/money.ts`.
- **API responses** are camelCase (`camel()` / `camelAll()`); errors are `{ error: { code, message, fields?, details? } }`.
- **UI:** reuse components in `apps/web/src/components/ui` and `apps/web/src/features/records`. No buttons without
  working behaviour. Every list/board needs loading, empty and error states. Check phone (390px), tablet (834px) and
  desktop (1440px) — no horizontal page scroll.
- Keep docs in `docs/` current when behaviour changes.

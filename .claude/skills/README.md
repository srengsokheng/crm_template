# Project skills

Claude Code loads every `SKILL.md` in this folder automatically for agents working in this repository.

These ten skills were copied unchanged from
[seb1n/awesome-ai-agent-skills](https://github.com/seb1n/awesome-ai-agent-skills) (commit `75865a5`, MIT licence — see
`LICENSE-awesome-ai-agent-skills`). They were reviewed before inclusion: plain Markdown, no scripts, no external calls.
The other ~90 skills in that collection (finance, marketing, ML, legal…) are not relevant to this project.

| Skill | Use it for |
|---|---|
| `frontend-design` | Design tokens, component variants and states, responsive layouts, dark mode, 44px tap targets |
| `accessibility-testing` | WCAG 2.1 AA audits, keyboard/screen-reader checks, axe in CI |
| `wireframing` | Component inventory + empty/error/loading states per screen before building it |
| `user-flow-mapping` | Mermaid flows for CRM journeys (lead → deal, import, merge) incl. error paths |
| `api-design` | List endpoints: pagination, filtering, sorting, consistent error envelope |
| `testing` | Test cases per feature, coverage gaps |
| `code-review` | Review a branch/PR before merging (bugs, security, N+1, DRY) |
| `refactoring` | Extracting shared components without changing behaviour |
| `lead-scoring` | Future lead-scoring feature (fit + engagement, Hot/Warm/Cold) |
| `crm-data-enrichment` | Duplicate matching/merge rules and data-quality fields |

Project rules in `/CLAUDE.md` always win over generic advice in these skills (e.g. we use offset pagination with
`page`/`pageSize`/`total`, not cursors; camelCase JSON; Tailwind tokens in `apps/web/src/styles.css`).

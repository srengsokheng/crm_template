/**
 * Dependency audit (`npm run audit`, also in CI):
 *  1. Production dependencies (what the server runs) must have no known vulnerabilities at all — no exceptions.
 *  2. Development tooling (build, tests, lint) may only have advisories listed in audit-allowlist.json, each with a
 *     reason and a review-by date. A new advisory, an advisory reaching production, or a passed review date fails.
 * Allowlist only advisories with no fixed version, after checking they can't be reached by outside input.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface Allowed { id: string; package: string; reason: string; reviewBy: string }
interface Via { source?: number; name?: string; title?: string; url?: string; severity?: string }
interface Report { vulnerabilities?: Record<string, { name: string; severity: string; via: (Via | string)[] }> }

function audit(args: string[]): Report {
  try {
    // Fixed arguments only (no user input), so a plain command line is safe on every platform.
    return JSON.parse(execSync(['npm', 'audit', '--json', ...args].join(' '), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    // npm audit exits non-zero when it finds something; the JSON is still on stdout.
    const out = (e as { stdout?: string }).stdout;
    if (!out) throw e;
    return JSON.parse(out);
  }
}
/** Advisories (GHSA ids) behind the findings, with the package they're in. */
function advisories(r: Report): Map<string, { pkg: string; title: string; severity: string }> {
  const out = new Map<string, { pkg: string; title: string; severity: string }>();
  for (const v of Object.values(r.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via === 'string' || !via.url) continue;
      const id = /GHSA-[\w-]+/.exec(via.url)?.[0] ?? via.url;
      out.set(id, { pkg: via.name ?? v.name, title: via.title ?? '', severity: via.severity ?? v.severity });
    }
  }
  return out;
}

const allowlist: Allowed[] = JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const problems: string[] = [];

const prod = advisories(audit(['--omit=dev']));
for (const [id, a] of prod) problems.push(`PRODUCTION ${a.severity}: ${a.pkg} — ${a.title} (${id}). Production dependencies may not have any.`);

const all = advisories(audit([]));
for (const [id, a] of all) {
  if (prod.has(id)) continue;
  const ok = allowlist.find((x) => x.id === id);
  if (!ok) problems.push(`dev ${a.severity}: ${a.pkg} — ${a.title} (${id}). Update the package, or allowlist it with a reason if no fix exists.`);
  else if (ok.reviewBy < today) problems.push(`allowlist entry for ${id} (${ok.package}) expired on ${ok.reviewBy}: check for a fix and update or extend it.`);
}
for (const x of allowlist) {
  if (!all.has(x.id)) console.log(`note: ${x.id} (${x.package}) is no longer reported — remove it from audit-allowlist.json.`);
}

if (problems.length) {
  console.error(problems.map((p) => `✖ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✔ audit: production dependencies have no known vulnerabilities; ${all.size} dev-tool advisor${all.size === 1 ? 'y' : 'ies'} allowlisted (see audit-allowlist.json).`);

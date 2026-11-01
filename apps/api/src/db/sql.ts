/**
 * Minimal parameterised SQL builder.
 *   sql`select * from t where id = ${id} and ${sql`x = ${y}`}`
 * Values are always bound as parameters; only `raw()` inserts trusted text (identifiers we control).
 */
export interface SqlQuery { text: string; values: unknown[] }

const RAW = Symbol('raw');
class Fragment {
  readonly strings: readonly string[];
  readonly params: unknown[];
  constructor(strings: readonly string[], params: unknown[]) { this.strings = strings; this.params = params; }
}
interface Raw { [RAW]: string }

export function raw(text: string): Raw { return { [RAW]: text }; }
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && RAW in v;

export function sql(strings: TemplateStringsArray | readonly string[], ...params: unknown[]): Fragment {
  return new Fragment(strings, params);
}

export function join(parts: Fragment[], sep = ', '): Fragment {
  if (parts.length === 0) return sql``;
  const strings: string[] = [''];
  const params: unknown[] = [];
  parts.forEach((p, i) => {
    if (i > 0) strings[strings.length - 1] += sep;
    params.push(p);
    strings.push('');
  });
  return new Fragment(strings, params);
}

export const empty = sql``;

export function and(parts: (Fragment | null | undefined | false)[]): Fragment {
  const list = parts.filter(Boolean) as Fragment[];
  return list.length ? sql`(${join(list, ' AND ')})` : sql`TRUE`;
}
export function or(parts: Fragment[]): Fragment {
  return parts.length ? sql`(${join(parts, ' OR ')})` : sql`FALSE`;
}

export function build(f: Fragment): SqlQuery {
  const values: unknown[] = [];
  const walk = (frag: Fragment): string => {
    let text = frag.strings[0];
    frag.params.forEach((p, i) => {
      if (p instanceof Fragment) text += walk(p);
      else if (isRaw(p)) text += p[RAW];
      else { values.push(p); text += `$${values.length}`; }
      text += frag.strings[i + 1];
    });
    return text;
  };
  return { text: walk(f), values };
}

export type { Fragment };

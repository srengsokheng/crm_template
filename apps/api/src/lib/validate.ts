import type { z } from 'zod';
import { AppError } from './errors.ts';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.entries(fields)[0];
  throw new AppError(400, 'VALIDATION_FAILED', first ? (first[0] === '_' ? first[1] : `${first[0]}: ${first[1]}`) : 'Invalid input', fields);
}

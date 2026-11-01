import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  details?: unknown;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>, details?: unknown) {
    super(message);
    this.status = status; this.code = code; this.fields = fields; this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'crm', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; fields?: Record<string, string>; details?: unknown } })?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`, e?.fields, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  patch: <T>(p: string, b: unknown = {}) => request<T>('PATCH', p, b),
  put: <T>(p: string, b: unknown = {}) => request<T>('PUT', p, b),
  del: <T = void>(p: string, b?: unknown) => request<T>('DELETE', p, b),
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export function qsOf(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from './api.ts';
import type { DictItem, FieldDef, Me, Meta, Pipeline, Scope } from './types.ts';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false, staleTime: 60_000 });
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: 60_000 });

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Can the current user perform an action (optionally on a specific record)? Mirrors server rules for UI hints. */
export function useCan() {
  const { data: me } = useMe();
  return (entity: keyof Me['permissions'], action: 'view' | 'create' | 'edit' | 'delete' | 'export' | 'import', ownerId?: number | null, visibility?: string): boolean => {
    if (!me) return false;
    if (me.role.isAdmin) return true;
    const s: Scope = me.permissions[entity]?.[action] ?? 'none';
    if (s === 'none') return false;
    if (ownerId === undefined) return true;
    if (s === 'all') return visibility !== 'private' || ownerId === me.user.id;
    if (s === 'own') return ownerId === me.user.id;
    return true; // team: the server has the team list; optimistic in the UI
  };
}

export function useDict(kind: string): DictItem[] {
  const { data } = useMeta();
  return (data?.dictionaries ?? []).filter((d) => d.kind === kind && d.isActive);
}
export function useDictLabel() {
  const { data } = useMeta();
  return (id: number | null | undefined) => (id ? data?.dictionaries.find((d) => d.id === id)?.label ?? '—' : '—');
}
export function usePipelines(entity: 'lead' | 'deal'): Pipeline[] {
  const { data } = useMeta();
  return (data?.pipelines ?? []).filter((p) => p.entityType === entity);
}
export function useFields(entity: string): FieldDef[] {
  const { data } = useMeta();
  return (data?.fields ?? []).filter((f) => f.entityType === entity && f.isActive);
}
export function useUserName() {
  const { data } = useMeta();
  return (id: number | null | undefined) => (id ? data?.users.find((u) => u.id === id)?.name ?? 'Unknown' : '—');
}

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: {
  success?: string | ((r: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void; onError?: (e: ApiError) => boolean | void;
} = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (e instanceof ApiError && opts.onError?.(e)) return;
      toast.error(errorMessage(e));
    },
  });
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  const set = (nv: T) => { setV(nv); try { localStorage.setItem(key, JSON.stringify(nv)); } catch { /* ignore */ } };
  return [v, set];
}

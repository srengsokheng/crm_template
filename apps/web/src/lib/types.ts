export type Scope = 'none' | 'own' | 'team' | 'all';
export interface Me {
  user: { id: number; name: string; email: string };
  role: { id: number; name: string; isAdmin: boolean };
  workspace: { id: number; name: string; baseCurrency: string; useLeads: boolean };
  permissions: Record<'lead' | 'deal' | 'contact' | 'company' | 'product' | 'activity', Record<'view' | 'create' | 'edit' | 'delete' | 'export' | 'import', Scope>>;
}
export interface Stage { id: number; pipelineId: number; name: string; color: string; sort: number; kind: 'open' | 'won' | 'lost'; probability: number | null; rotDays: number | null }
export interface Pipeline { id: number; entityType: 'lead' | 'deal'; name: string; sort: number; isDefault: boolean; stages: Stage[] }
export interface DictItem { id: number; kind: string; label: string; sort: number; isActive: boolean }
export interface FieldOption { id: string; label: string }
export interface FieldDef {
  id: number; entityType: string; key: string; label: string; type: string; options: FieldOption[];
  required: 'never' | 'always' | 'from_stage'; requiredStageIds: number[]; helpText: string | null; sort: number; isActive: boolean;
}
export interface MetaUser { id: number; name: string; email: string; status: string; roleId: number; roleName: string }
export interface Meta {
  users: MetaUser[]; pipelines: Pipeline[]; dictionaries: DictItem[]; fields: FieldDef[];
  teams: { id: number; name: string; memberIds: number[] }[]; productCategories: { id: number; name: string }[];
}
export interface ListResponse<T> { data: T[]; page: number; pageSize: number; total: number; aggregates?: Record<string, string> }
export interface Method { id?: number; kind: 'phone' | 'email' | 'website' | 'messenger'; label: string; value: string; isPrimary?: boolean }
export interface NextActivity { id: number; subject: string; dueAt: string | null; kind: string }
export interface LineItem {
  id?: number; productId: number | null; name: string; unitPrice: string; quantity: string | number; unit: string;
  discountType: 'percent' | 'amount' | null; discountValue: string | number | null; taxRate: string | number | null; taxIncluded: boolean; lineTotal?: string;
}
export interface Activity {
  id: number; kind: 'task' | 'call' | 'meeting' | 'email' | 'deadline'; subject: string; description: string | null; dueAt: string | null;
  durationMinutes: number | null; priority: 'low' | 'normal' | 'high'; assigneeId: number | null; assigneeName: string | null;
  status: 'open' | 'done' | 'canceled'; completedAt: string | null; reminderAt: string | null; direction: string | null; outcome: string | null;
  location: string | null; createdAt: string; links: { entityType: string; entityId: number; title: string }[];
}
export type RecordType = 'lead' | 'deal' | 'contact' | 'company';

export const RECORD_TYPES = ['lead', 'deal', 'contact', 'company'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const PERMISSION_ENTITIES = ['lead', 'deal', 'contact', 'company', 'product', 'activity'] as const;
export type PermissionEntity = (typeof PERMISSION_ENTITIES)[number];

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'import'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const SCOPES = ['none', 'own', 'team', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_COLORS = [
  'slate', 'blue', 'sky', 'cyan', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'pink', 'violet',
] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

export const ACTIVITY_KINDS = ['task', 'call', 'meeting', 'email', 'deadline'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const PRIORITIES = ['low', 'normal', 'high'] as const;

export const CONTACT_METHOD_KINDS = ['phone', 'email', 'website', 'messenger'] as const;
export type ContactMethodKind = (typeof CONTACT_METHOD_KINDS)[number];

export const DICTIONARY_KINDS = [
  'lead_source', 'lost_reason', 'disqualify_reason', 'contact_type', 'company_type', 'industry', 'company_size', 'deal_type',
] as const;
export type DictionaryKind = (typeof DICTIONARY_KINDS)[number];

export const DICTIONARY_LABELS: Record<DictionaryKind, string> = {
  lead_source: 'Lead sources',
  lost_reason: 'Lost reasons',
  disqualify_reason: 'Disqualify reasons',
  contact_type: 'Contact types',
  company_type: 'Company types',
  industry: 'Industries',
  company_size: 'Company sizes',
  deal_type: 'Deal types',
};

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'money', 'date', 'datetime', 'boolean', 'select', 'multiselect', 'url', 'user',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_ENTITY_TYPES = ['lead', 'deal', 'contact', 'company', 'product'] as const;
export type FieldEntityType = (typeof FIELD_ENTITY_TYPES)[number];

export const AUTOMATION_TRIGGERS = ['stage_entered', 'created'] as const;
export const AUTOMATION_ACTIONS = ['create_activity', 'notify', 'add_note', 'update_field', 'assign_owner', 'move_stage'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'KHR', 'THB', 'SGD', 'JPY', 'CNY', 'AUD', 'CAD'] as const;

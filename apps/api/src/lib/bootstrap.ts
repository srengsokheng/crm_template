import type { PermissionAction, PermissionEntity, Scope } from '@crm/shared';
import { q, q1, sql, type Db } from '../db/index.ts';

type Grants = Partial<Record<PermissionEntity, Partial<Record<PermissionAction, Scope>>>>;

const all = (scope: Scope, extra: Partial<Record<PermissionAction, Scope>> = {}) =>
  ({ view: scope, create: scope === 'none' ? 'none' : 'all', edit: scope, delete: scope, export: scope, ...extra }) as Record<PermissionAction, Scope>;

export const DEFAULT_ROLES: { name: string; isAdmin: boolean; grants: Grants }[] = [
  { name: 'Admin', isAdmin: true, grants: {} },
  {
    name: 'Manager', isAdmin: false,
    grants: {
      lead: all('all', { import: 'all' }), deal: all('all'), contact: all('all', { import: 'all' }), company: all('all', { import: 'all' }),
      product: all('all'), activity: all('all'),
    },
  },
  {
    name: 'Sales rep', isAdmin: false,
    grants: {
      lead: all('team', { edit: 'own', delete: 'own', export: 'none' }),
      deal: all('team', { edit: 'own', delete: 'own', export: 'none' }),
      contact: all('all', { edit: 'team', delete: 'own', export: 'none' }),
      company: all('all', { edit: 'team', delete: 'own', export: 'none' }),
      product: { view: 'all', create: 'none', edit: 'none', delete: 'none', export: 'none' },
      activity: all('team', { edit: 'own', delete: 'own', export: 'none' }),
    },
  },
  {
    name: 'Viewer', isAdmin: false,
    grants: Object.fromEntries((['lead', 'deal', 'contact', 'company', 'product', 'activity'] as const).map((e) =>
      [e, { view: 'all', create: 'none', edit: 'none', delete: 'none', export: 'none' }])) as Grants,
  },
];

const LEAD_STAGES = [
  { name: 'New', color: 'blue', kind: 'open' }, { name: 'Contacted', color: 'sky', kind: 'open' },
  { name: 'Qualified', color: 'teal', kind: 'open' }, { name: 'Converted', color: 'emerald', kind: 'won' },
  { name: 'Disqualified', color: 'rose', kind: 'lost' },
];
const DEAL_STAGES = [
  { name: 'New', color: 'blue', kind: 'open', probability: 10 }, { name: 'Qualified', color: 'sky', kind: 'open', probability: 25 },
  { name: 'Proposal', color: 'violet', kind: 'open', probability: 50 }, { name: 'Negotiation', color: 'amber', kind: 'open', probability: 75 },
  { name: 'Won', color: 'emerald', kind: 'won', probability: 100 }, { name: 'Lost', color: 'rose', kind: 'lost', probability: 0 },
];
const DICTIONARIES: Record<string, string[]> = {
  lead_source: ['Website', 'Referral', 'Phone call', 'Email', 'Event', 'Advertising', 'Partner', 'Other'],
  lost_reason: ['Price too high', 'Chose a competitor', 'No budget', 'No decision', 'Not a fit', 'Other'],
  disqualify_reason: ['Not interested', 'Spam / junk', 'Wrong contact', 'Duplicate', 'Other'],
  contact_type: ['Customer', 'Prospect', 'Partner', 'Supplier', 'Other'],
  company_type: ['Customer', 'Prospect', 'Partner', 'Supplier', 'Competitor', 'Other'],
  industry: ['Technology', 'Manufacturing', 'Retail', 'Finance', 'Healthcare', 'Education', 'Hospitality', 'Construction', 'Government', 'Other'],
  company_size: ['1–10', '11–50', '51–200', '201–1000', '1000+'],
  deal_type: ['New business', 'Upsell', 'Renewal', 'Services'],
};

export async function setRoleGrants(db: Db, roleId: number, grants: Grants): Promise<void> {
  await q(sql`DELETE FROM role_grants WHERE role_id = ${roleId}`, db);
  for (const [entity, actions] of Object.entries(grants)) {
    for (const [action, scope] of Object.entries(actions ?? {})) {
      await q(sql`INSERT INTO role_grants (role_id, entity, action, scope) VALUES (${roleId}, ${entity}, ${action}, ${scope})`, db);
    }
  }
}

export async function createPipeline(db: Db, workspaceId: number, entityType: 'lead' | 'deal', name: string, isDefault: boolean, sort = 0): Promise<number> {
  const p = await q1<{ id: number }>(sql`INSERT INTO pipelines (workspace_id, entity_type, name, is_default, sort)
    VALUES (${workspaceId}, ${entityType}, ${name}, ${isDefault}, ${sort}) RETURNING id`, db);
  const stages = entityType === 'lead' ? LEAD_STAGES : DEAL_STAGES;
  let i = 0;
  for (const s of stages) {
    await q(sql`INSERT INTO stages (pipeline_id, name, color, kind, sort, probability)
      VALUES (${p!.id}, ${s.name}, ${s.color}, ${s.kind}, ${i++}, ${'probability' in s ? s.probability : null})`, db);
  }
  return p!.id;
}

/** Seed roles, pipelines and dictionaries for a brand-new workspace. Returns the Admin role id. */
export async function createWorkspaceDefaults(db: Db, workspaceId: number): Promise<number> {
  let adminId = 0;
  for (const r of DEFAULT_ROLES) {
    const row = await q1<{ id: number }>(sql`INSERT INTO roles (workspace_id, name, is_admin, is_system)
      VALUES (${workspaceId}, ${r.name}, ${r.isAdmin}, true) RETURNING id`, db);
    await setRoleGrants(db, row!.id, r.grants);
    if (r.isAdmin) adminId = row!.id;
  }
  await createPipeline(db, workspaceId, 'lead', 'Leads', true);
  await createPipeline(db, workspaceId, 'deal', 'Sales pipeline', true);
  for (const [kind, labels] of Object.entries(DICTIONARIES)) {
    let i = 0;
    for (const label of labels) {
      await q(sql`INSERT INTO dictionary_items (workspace_id, kind, label, sort) VALUES (${workspaceId}, ${kind}, ${label}, ${i++})`, db);
    }
  }
  return adminId;
}

import type { FieldRules, PermissionAction, PermissionEntity, Scope } from '@crm/shared';

export interface Ctx {
  userId: number;
  workspaceId: number;
  userName: string;
  email: string;
  roleId: number;
  roleName: string;
  isAdmin: boolean;
  grants: Partial<Record<PermissionEntity, Partial<Record<PermissionAction, Scope>>>>;
  teamUserIds: number[];
  /** Pipelines this user's role may not use (restricted to other roles). Empty for admins and automation. */
  blockedPipelineIds: number[];
  /** Field-level rules of the user's role (ignored for admins). */
  fieldRules?: FieldRules;
  baseCurrency: string;
  useLeads: boolean;
  /** Automation nesting depth (loop guard). */
  depth?: number;
}

/** Context used by automation / system jobs: full access inside one workspace. */
export function systemCtx(workspaceId: number, userId: number, baseCurrency = 'USD'): Ctx {
  return {
    userId, workspaceId, userName: 'Automation', email: '', roleId: 0, roleName: 'system', isAdmin: true,
    grants: {}, teamUserIds: [userId], blockedPipelineIds: [], baseCurrency, useLeads: true, depth: 0,
  };
}

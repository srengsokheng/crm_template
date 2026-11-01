import type { PermissionAction, PermissionEntity, Scope } from '@crm/shared';

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
  baseCurrency: string;
  useLeads: boolean;
  /** Automation nesting depth (loop guard). */
  depth?: number;
}

/** Context used by automation / system jobs: full access inside one workspace. */
export function systemCtx(workspaceId: number, userId: number, baseCurrency = 'USD'): Ctx {
  return {
    userId, workspaceId, userName: 'Automation', email: '', roleId: 0, roleName: 'system', isAdmin: true,
    grants: {}, teamUserIds: [userId], baseCurrency, useLeads: true, depth: 0,
  };
}

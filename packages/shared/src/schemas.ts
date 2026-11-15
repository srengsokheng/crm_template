import { z } from 'zod';
import {
  ACTIVITY_KINDS, AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONTACT_METHOD_KINDS, DICTIONARY_KINDS,
  FIELD_ENTITY_TYPES, FIELD_TYPES, PERMISSION_ACTIONS, PERMISSION_ENTITIES, PRIORITIES, RECORD_TYPES, SCOPES, STAGE_COLORS, STAGE_KINDS,
} from './enums.ts';
import { DATE_FORMATS, DUPLICATE_MODES, IMPORT_ENTITIES, IMPORT_LIMITS, MATCH_KEYS } from './imports.ts';

const trimmed = (max = 200) => z.string().trim().max(max);
const optText = (max = 200) => trimmed(max).nullish().transform((v) => (v ? v : null));
export const idSchema = z.coerce.number().int().positive();
const optId = z.union([idSchema, z.null()]).optional();
export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), 'Enter an amount like 1500 or 1500.50');
const optMoney = z.union([moneySchema, z.null(), z.literal('').transform(() => null)]).optional();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optDate = z.union([dateSchema, z.null(), z.literal('').transform(() => null)]).optional();
const currency = z.string().regex(/^[A-Z]{3}$/).optional();
const visibility = z.enum(['shared', 'private']).optional();
export const customSchema = z.record(z.string(), z.unknown()).optional();

export const addressSchema = z
  .object({
    street: optText(200), city: optText(100), region: optText(100), postalCode: optText(20), country: optText(100),
  })
  .nullish();

export const contactMethodSchema = z.object({
  kind: z.enum(CONTACT_METHOD_KINDS),
  label: trimmed(40).default('work'),
  value: trimmed(200).min(1, 'Required'),
});
export type ContactMethodInput = z.infer<typeof contactMethodSchema>;

const methods = z
  .array(contactMethodSchema)
  .max(20)
  .superRefine((arr, ctx) => {
    arr.forEach((m, i) => {
      if (m.kind === 'email' && !z.email().safeParse(m.value).success)
        ctx.addIssue({ code: 'custom', message: 'Invalid email address', path: [i, 'value'] });
      if (m.kind === 'phone' && !/^[+()\d\s.-]{5,30}$/.test(m.value))
        ctx.addIssue({ code: 'custom', message: 'Invalid phone number', path: [i, 'value'] });
    });
  })
  .optional();

// ───────── Auth ─────────
export const signupSchema = z.object({
  workspaceName: trimmed(100).min(1, 'Required'),
  name: trimmed(100).min(1, 'Required'),
  email: z.email('Invalid email address').max(200),
  password: z.string().min(8, 'At least 8 characters').max(200),
});
export const loginSchema = z.object({ email: z.email('Invalid email address'), password: z.string().min(1, 'Required') });
export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  name: trimmed(100).min(1, 'Required'),
  password: z.string().min(8, 'At least 8 characters').max(200),
});

// ───────── Lists ─────────
export const listQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.string().max(100).optional(),
  })
  .loose();
export type ListQuery = z.infer<typeof listQuerySchema>;

// ───────── Contacts & companies ─────────
const contactBase = {
  firstName: optText(100), lastName: optText(100), jobTitle: optText(100), birthday: optDate,
  typeId: optId, sourceId: optId, primaryCompanyId: optId, companyIds: z.array(idSchema).max(50).optional(),
  address: addressSchema, description: optText(5000), ownerId: optId, visibility, custom: customSchema, methods,
};
export const contactCreateSchema = z
  .object(contactBase)
  .refine((v) => v.firstName || v.lastName, { message: 'Enter a first or last name', path: ['firstName'] });
export const contactUpdateSchema = z.object(contactBase).partial().extend({ version: z.number().int().optional() });

const companyBase = {
  name: trimmed(200).min(1, 'Required'), typeId: optId, industryId: optId, sizeId: optId, sourceId: optId,
  annualRevenue: optMoney, currency, address: addressSchema, description: optText(5000), ownerId: optId,
  visibility, custom: customSchema, methods,
};
export const companyCreateSchema = z.object(companyBase);
export const companyUpdateSchema = z.object(companyBase).partial().extend({ version: z.number().int().optional() });

// ───────── Leads ─────────
const leadBase = {
  title: optText(200), firstName: optText(100), lastName: optText(100), jobTitle: optText(100), companyName: optText(200),
  pipelineId: optId, stageId: optId, sourceId: optId, sourceDetails: optText(500), amount: optMoney, currency,
  address: addressSchema, description: optText(5000), ownerId: optId, visibility, custom: customSchema, methods,
};
export const leadCreateSchema = z
  .object(leadBase)
  .refine((v) => v.title || v.firstName || v.lastName || v.companyName || (v.methods && v.methods.length > 0), {
    message: 'Enter at least a title, a name, a company or a phone/email',
    path: ['title'],
  });
export const leadUpdateSchema = z.object(leadBase).partial().extend({ version: z.number().int().optional() });

const partyChoice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }),
  z.object({ mode: z.literal('existing'), id: idSchema }),
  z.object({ mode: z.literal('skip') }),
]);
export const convertLeadSchema = z.object({
  contact: partyChoice,
  company: partyChoice,
  deal: z.union([
    z.object({
      create: z.literal(true),
      pipelineId: optId, stageId: optId, title: optText(200), amount: optMoney, custom: customSchema,
    }),
    z.object({ create: z.literal(false) }),
  ]),
});
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

// ───────── Deals ─────────
const dealBase = {
  title: trimmed(200).min(1, 'Required'), pipelineId: optId, stageId: optId, amount: optMoney, currency,
  amountMode: z.enum(['auto', 'manual']).optional(), probability: z.coerce.number().int().min(0).max(100).nullish(),
  expectedCloseDate: optDate, companyId: optId, contactIds: z.array(idSchema).max(50).optional(),
  dealTypeId: optId, sourceId: optId, description: optText(5000), ownerId: optId, visibility, custom: customSchema,
};
export const dealCreateSchema = z.object(dealBase);
export const dealUpdateSchema = z.object(dealBase).partial().extend({ version: z.number().int().optional() });
export const moveSchema = z.object({ stageId: idSchema, custom: customSchema, lostReasonId: optId, lostNote: optText(1000) });
export const closeDealSchema = z.object({
  outcome: z.enum(['won', 'lost']),
  stageId: optId,
  lostReasonId: optId,
  lostNote: optText(1000),
  custom: customSchema,
});
export const disqualifySchema = z.object({ reasonId: optId, stageId: optId, note: optText(1000) });

// ───────── Products & line items ─────────
export const productCreateSchema = z.object({
  name: trimmed(200).min(1, 'Required'), sku: optText(60), categoryId: optId, description: optText(5000),
  unitPrice: moneySchema.default('0'), currency, unit: trimmed(20).default('pcs'),
  taxRate: z.coerce.number().min(0).max(100).nullish(), taxIncluded: z.boolean().optional(), isActive: z.boolean().optional(),
});
export const productUpdateSchema = productCreateSchema.partial();
export const lineItemSchema = z.object({
  productId: optId,
  name: trimmed(200).min(1, 'Required'),
  unitPrice: moneySchema,
  quantity: z.coerce.number().positive('Must be > 0').max(1e9),
  unit: trimmed(20).default('pcs'),
  discountType: z.enum(['percent', 'amount']).nullish(),
  discountValue: z.coerce.number().min(0).nullish(),
  taxRate: z.coerce.number().min(0).max(100).nullish(),
  taxIncluded: z.boolean().optional(),
});
export const lineItemsSchema = z.object({ items: z.array(lineItemSchema).max(200) });

// ───────── Activities & notes ─────────
export const linkSchema = z.object({ entityType: z.enum(RECORD_TYPES), entityId: idSchema });
const activityBase = {
  kind: z.enum(ACTIVITY_KINDS),
  subject: trimmed(200).min(1, 'Required'),
  description: optText(5000),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  durationMinutes: z.coerce.number().int().min(0).max(10080).nullish(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: optId,
  reminderMinutesBefore: z.coerce.number().int().min(0).max(10080).nullish(),
  direction: z.enum(['inbound', 'outbound']).nullish(),
  outcome: optText(200),
  location: optText(200),
  status: z.enum(['open', 'done', 'canceled']).optional(),
  links: z.array(linkSchema).max(10).optional(),
};
export const activityCreateSchema = z.object(activityBase);
export const activityUpdateSchema = z.object(activityBase).partial();
export const noteCreateSchema = z.object({
  entityType: z.enum(RECORD_TYPES), entityId: idSchema, body: trimmed(10000).min(1, 'Required'), isPinned: z.boolean().optional(),
});
export const noteUpdateSchema = z.object({ body: trimmed(10000).min(1).optional(), isPinned: z.boolean().optional() });

// ───────── Settings ─────────
export const pipelineCreateSchema = z.object({ entityType: z.enum(['lead', 'deal']), name: trimmed(100).min(1, 'Required') });
export const pipelineUpdateSchema = z.object({ name: trimmed(100).min(1).optional(), isDefault: z.boolean().optional() });
export const stageSchema = z.object({
  name: trimmed(60).min(1, 'Required'),
  color: z.enum(STAGE_COLORS).default('slate'),
  kind: z.enum(STAGE_KINDS).default('open'),
  probability: z.coerce.number().int().min(0).max(100).nullish(),
  rotDays: z.coerce.number().int().min(1).max(365).nullish(),
});
export const stageUpdateSchema = stageSchema.partial();
export const reorderSchema = z.object({ ids: z.array(idSchema).min(1).max(100) });
export const stageDeleteSchema = z.object({ moveToStageId: optId });

export const fieldOptionSchema = z.object({ id: z.string().min(1).max(40), label: trimmed(100).min(1) });
export const fieldCreateSchema = z.object({
  entityType: z.enum(FIELD_ENTITY_TYPES),
  label: trimmed(100).min(1, 'Required'),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Lowercase letters, digits, underscore').optional(),
  type: z.enum(FIELD_TYPES),
  options: z.array(fieldOptionSchema).max(100).default([]),
  required: z.enum(['never', 'always', 'from_stage']).default('never'),
  requiredStageIds: z.array(idSchema).max(50).default([]),
  helpText: optText(300),
});
export const fieldUpdateSchema = fieldCreateSchema.omit({ entityType: true, key: true, type: true }).partial().extend({
  isActive: z.boolean().optional(),
});

export const dictionaryItemSchema = z.object({ kind: z.enum(DICTIONARY_KINDS), label: trimmed(100).min(1, 'Required') });
export const dictionaryUpdateSchema = z.object({ label: trimmed(100).min(1).optional(), isActive: z.boolean().optional() });

const grantsSchema = z.partialRecord(z.enum(PERMISSION_ENTITIES), z.partialRecord(z.enum(PERMISSION_ACTIONS), z.enum(SCOPES)));
export const roleCreateSchema = z.object({ name: trimmed(60).min(1, 'Required'), grants: grantsSchema.default({}) });
export const roleUpdateSchema = z.object({ name: trimmed(60).min(1).optional(), grants: grantsSchema.optional() });
export const inviteSchema = z.object({ email: z.email('Invalid email address'), name: trimmed(100).min(1, 'Required'), roleId: idSchema });
export const memberUpdateSchema = z.object({ roleId: idSchema.optional(), status: z.enum(['active', 'disabled']).optional() });
export const teamSchema = z.object({ name: trimmed(60).min(1, 'Required'), memberIds: z.array(idSchema).max(500).default([]) });
export const workspaceUpdateSchema = z.object({
  name: trimmed(100).min(1).optional(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  useLeads: z.boolean().optional(),
});

export const conditionSchema = z.object({
  field: z.string().min(1).max(60),
  op: z.enum(['eq', 'neq', 'gt', 'lt', 'empty', 'not_empty']),
  value: z.unknown().optional(),
});
export const automationRuleSchema = z.object({
  entityType: z.enum(['lead', 'deal']),
  pipelineId: idSchema,
  stageId: optId,
  trigger: z.enum(AUTOMATION_TRIGGERS),
  delayMinutes: z.coerce.number().int().min(0).max(525600).default(0),
  conditions: z.array(conditionSchema).max(10).default([]),
  action: z.enum(AUTOMATION_ACTIONS),
  config: z.record(z.string(), z.unknown()).default({}),
  isEnabled: z.boolean().default(true),
});
export const automationRuleUpdateSchema = automationRuleSchema.partial();

// ───────── CSV import ─────────
export const importUploadSchema = z.object({
  entityType: z.enum(IMPORT_ENTITIES),
  fileName: trimmed(200).min(1, 'Required'),
  content: z.string().min(1, 'The file is empty').max(IMPORT_LIMITS.maxBytes, 'The file is larger than 5 MB'),
});
export const importOptionsSchema = z.object({
  duplicateMode: z.enum(DUPLICATE_MODES).default('skip'),
  matchBy: z.array(z.enum(MATCH_KEYS)).max(MATCH_KEYS.length).default([]),
  dateFormat: z.enum(DATE_FORMATS).default('ymd'),
  /** Owner for rows without an Owner column value (default: the importing user). */
  ownerId: optId,
  /** Contacts: create companies named in the Company column that don't exist yet. */
  createCompanies: z.boolean().default(true),
  /** Leads: pipeline to import into (default pipeline when empty). */
  pipelineId: optId,
  /** Leads: run "created" / "stage entered" automation rules for imported leads. */
  runAutomation: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;
export const importConfigSchema = z.object({
  mapping: z.array(z.string().max(80).nullable()).max(IMPORT_LIMITS.maxColumns),
  options: importOptionsSchema.default(importOptionsSchema.parse({})),
});
export type ImportConfig = z.infer<typeof importConfigSchema>;

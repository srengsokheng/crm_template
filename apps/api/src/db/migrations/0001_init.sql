-- Acme CRM initial schema. See docs/DATABASE_SCHEMA.md.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────── Identity & access ─────────────
CREATE TABLE workspaces (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  base_currency char(3) NOT NULL DEFAULT 'USD',
  timezone      text NOT NULL DEFAULT 'UTC',
  settings      jsonb NOT NULL DEFAULT '{"useLeads": true}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  password_hash text,
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  is_admin     boolean NOT NULL DEFAULT false,
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE role_grants (
  role_id bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  entity  text NOT NULL,
  action  text NOT NULL,
  scope   text NOT NULL CHECK (scope IN ('none','own','team','all')),
  PRIMARY KEY (role_id, entity, action)
);

CREATE TABLE memberships (
  workspace_id      bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id           bigint NOT NULL REFERENCES roles(id),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  invite_token_hash text,
  invited_by        bigint REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE UNIQUE INDEX memberships_invite_token ON memberships (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE teams (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE TABLE team_members (
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- ───────────── Pipelines & dictionaries ─────────────
CREATE TABLE pipelines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('lead','deal')),
  name         text NOT NULL,
  sort         int NOT NULL DEFAULT 0,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (workspace_id, entity_type) WHERE is_default;

CREATE TABLE stages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pipeline_id bigint NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT 'slate',
  sort        int NOT NULL DEFAULT 0,
  kind        text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  probability smallint CHECK (probability BETWEEN 0 AND 100),
  rot_days    int
);
CREATE INDEX stages_pipeline ON stages (pipeline_id, sort);
CREATE UNIQUE INDEX stages_one_won ON stages (pipeline_id) WHERE kind = 'won';

CREATE TABLE dictionary_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  label        text NOT NULL,
  sort         int NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (workspace_id, kind, label)
);

-- ───────────── Parties ─────────────
CREATE TABLE companies (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version         int NOT NULL DEFAULT 1,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  type_id         bigint REFERENCES dictionary_items(id),
  industry_id     bigint REFERENCES dictionary_items(id),
  size_id         bigint REFERENCES dictionary_items(id),
  source_id       bigint REFERENCES dictionary_items(id),
  annual_revenue  numeric(18,2),
  currency        char(3) NOT NULL DEFAULT 'USD',
  address         jsonb,
  description     text,
  owner_id        bigint REFERENCES users(id),
  visibility      text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  custom          jsonb NOT NULL DEFAULT '{}',
  created_by      bigint REFERENCES users(id),
  updated_by      bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      bigint REFERENCES users(id)
);
CREATE INDEX companies_ws_owner ON companies (workspace_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE INDEX companies_custom ON companies USING gin (custom);

CREATE TABLE contacts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id       bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version            int NOT NULL DEFAULT 1,
  first_name         text,
  last_name          text,
  job_title          text,
  birthday           date,
  type_id            bigint REFERENCES dictionary_items(id),
  source_id          bigint REFERENCES dictionary_items(id),
  primary_company_id bigint REFERENCES companies(id) ON DELETE SET NULL,
  address            jsonb,
  description        text,
  owner_id           bigint REFERENCES users(id),
  visibility         text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  custom             jsonb NOT NULL DEFAULT '{}',
  created_by         bigint REFERENCES users(id),
  updated_by         bigint REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  deleted_by         bigint REFERENCES users(id),
  CHECK (coalesce(trim(first_name), '') <> '' OR coalesce(trim(last_name), '') <> '')
);
CREATE INDEX contacts_ws_owner ON contacts (workspace_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_name_trgm ON contacts USING gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);
CREATE INDEX contacts_company ON contacts (primary_company_id);
CREATE INDEX contacts_custom ON contacts USING gin (custom);

CREATE TABLE contact_companies (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       text,
  PRIMARY KEY (contact_id, company_id)
);
CREATE INDEX contact_companies_company ON contact_companies (company_id);

CREATE TABLE contact_methods (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  party_type   text NOT NULL CHECK (party_type IN ('lead','contact','company')),
  party_id     bigint NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('phone','email','website','messenger')),
  label        text NOT NULL DEFAULT 'work',
  value        text NOT NULL,
  normalized   text NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  sort         int NOT NULL DEFAULT 0
);
CREATE INDEX contact_methods_party ON contact_methods (party_type, party_id);
CREATE INDEX contact_methods_dupe ON contact_methods (workspace_id, kind, normalized);
CREATE INDEX contact_methods_value_trgm ON contact_methods USING gin (normalized gin_trgm_ops);

-- ───────────── Leads & deals ─────────────
CREATE TABLE leads (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id           bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version                int NOT NULL DEFAULT 1,
  title                  text NOT NULL CHECK (length(trim(title)) > 0),
  first_name             text,
  last_name              text,
  job_title              text,
  company_name           text,
  pipeline_id            bigint NOT NULL REFERENCES pipelines(id),
  stage_id               bigint NOT NULL REFERENCES stages(id),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  source_id              bigint REFERENCES dictionary_items(id),
  source_details         text,
  amount                 numeric(18,2),
  currency               char(3) NOT NULL DEFAULT 'USD',
  address                jsonb,
  description            text,
  owner_id               bigint REFERENCES users(id),
  visibility             text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  custom                 jsonb NOT NULL DEFAULT '{}',
  converted_at           timestamptz,
  converted_contact_id   bigint REFERENCES contacts(id) ON DELETE SET NULL,
  converted_company_id   bigint REFERENCES companies(id) ON DELETE SET NULL,
  converted_deal_id      bigint,
  disqualify_reason_id   bigint REFERENCES dictionary_items(id),
  stage_changed_at       timestamptz NOT NULL DEFAULT now(),
  stage_changed_by       bigint REFERENCES users(id),
  created_by             bigint REFERENCES users(id),
  updated_by             bigint REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  deleted_by             bigint REFERENCES users(id)
);
CREATE INDEX leads_board ON leads (workspace_id, pipeline_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner ON leads (workspace_id, owner_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leads_title_trgm ON leads USING gin ((title || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(company_name,'')) gin_trgm_ops);
CREATE INDEX leads_custom ON leads USING gin (custom);

CREATE TABLE deals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id        bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version             int NOT NULL DEFAULT 1,
  title               text NOT NULL CHECK (length(trim(title)) > 0),
  pipeline_id         bigint NOT NULL REFERENCES pipelines(id),
  stage_id            bigint NOT NULL REFERENCES stages(id),
  previous_stage_id   bigint REFERENCES stages(id),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  amount              numeric(18,2) NOT NULL DEFAULT 0,
  currency            char(3) NOT NULL DEFAULT 'USD',
  amount_mode         text NOT NULL DEFAULT 'auto' CHECK (amount_mode IN ('auto','manual')),
  probability         smallint CHECK (probability BETWEEN 0 AND 100),
  expected_close_date date,
  closed_at           timestamptz,
  lost_reason_id      bigint REFERENCES dictionary_items(id),
  lost_note           text,
  company_id          bigint REFERENCES companies(id) ON DELETE SET NULL,
  deal_type_id        bigint REFERENCES dictionary_items(id),
  source_id           bigint REFERENCES dictionary_items(id),
  lead_id             bigint REFERENCES leads(id) ON DELETE SET NULL,
  description         text,
  owner_id            bigint REFERENCES users(id),
  visibility          text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','private')),
  custom              jsonb NOT NULL DEFAULT '{}',
  stage_changed_at    timestamptz NOT NULL DEFAULT now(),
  stage_changed_by    bigint REFERENCES users(id),
  created_by          bigint REFERENCES users(id),
  updated_by          bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  deleted_by          bigint REFERENCES users(id)
);
ALTER TABLE leads ADD CONSTRAINT leads_converted_deal_fk FOREIGN KEY (converted_deal_id) REFERENCES deals(id) ON DELETE SET NULL;
CREATE INDEX deals_board ON deals (workspace_id, pipeline_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX deals_owner ON deals (workspace_id, owner_id, status) WHERE deleted_at IS NULL;
CREATE INDEX deals_close ON deals (workspace_id, expected_close_date);
CREATE INDEX deals_closed_at ON deals (workspace_id, closed_at);
CREATE INDEX deals_company ON deals (company_id);
CREATE INDEX deals_title_trgm ON deals USING gin (title gin_trgm_ops);
CREATE INDEX deals_custom ON deals USING gin (custom);

CREATE TABLE deal_contacts (
  deal_id    bigint NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (deal_id, contact_id)
);
CREATE INDEX deal_contacts_contact ON deal_contacts (contact_id);

CREATE TABLE stage_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('lead','deal')),
  entity_id     bigint NOT NULL,
  from_stage_id bigint REFERENCES stages(id) ON DELETE SET NULL,
  to_stage_id   bigint REFERENCES stages(id) ON DELETE SET NULL,
  moved_by      bigint REFERENCES users(id),
  moved_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_history_entity ON stage_history (entity_type, entity_id, moved_at);

-- ───────────── Products ─────────────
CREATE TABLE product_categories (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort         int NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, name)
);

CREATE TABLE products (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version      int NOT NULL DEFAULT 1,
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  sku          text,
  category_id  bigint REFERENCES product_categories(id) ON DELETE SET NULL,
  description  text,
  unit_price   numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  unit         text NOT NULL DEFAULT 'pcs',
  tax_rate     numeric(5,2) CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_included boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX products_sku ON products (workspace_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

CREATE TABLE line_items (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_type    text NOT NULL CHECK (parent_type IN ('lead','deal')),
  parent_id      bigint NOT NULL,
  product_id     bigint REFERENCES products(id) ON DELETE SET NULL,
  name           text NOT NULL,
  unit_price     numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity       numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'pcs',
  discount_type  text CHECK (discount_type IN ('percent','amount')),
  discount_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_rate       numeric(5,2) CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_included   boolean NOT NULL DEFAULT false,
  line_total     numeric(18,2) NOT NULL DEFAULT 0,
  sort           int NOT NULL DEFAULT 0
);
CREATE INDEX line_items_parent ON line_items (parent_type, parent_id, sort);

-- ───────────── Activities, notes, audit ─────────────
CREATE TABLE activities (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version          int NOT NULL DEFAULT 1,
  kind             text NOT NULL CHECK (kind IN ('task','call','meeting','email','deadline')),
  subject          text NOT NULL CHECK (length(trim(subject)) > 0),
  description      text,
  due_at           timestamptz,
  duration_minutes int,
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  assignee_id      bigint REFERENCES users(id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','canceled')),
  completed_at     timestamptz,
  completed_by     bigint REFERENCES users(id),
  reminder_at      timestamptz,
  reminded_at      timestamptz,
  direction        text CHECK (direction IN ('inbound','outbound')),
  outcome          text,
  location         text,
  created_by       bigint REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX activities_my_day ON activities (workspace_id, assignee_id, status, due_at) WHERE deleted_at IS NULL;
CREATE INDEX activities_reminder ON activities (reminder_at) WHERE status = 'open' AND reminded_at IS NULL;

CREATE TABLE activity_links (
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('lead','deal','contact','company')),
  entity_id   bigint NOT NULL,
  PRIMARY KEY (activity_id, entity_type, entity_id)
);
CREATE INDEX activity_links_entity ON activity_links (entity_type, entity_id);

CREATE TABLE notes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('lead','deal','contact','company')),
  entity_id    bigint NOT NULL,
  body         text NOT NULL CHECK (length(trim(body)) > 0),
  is_pinned    boolean NOT NULL DEFAULT false,
  author_type  text NOT NULL DEFAULT 'user' CHECK (author_type IN ('user','automation','system')),
  author_id    bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX notes_entity ON notes (entity_type, entity_id, created_at DESC);

CREATE TABLE audit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    bigint NOT NULL,
  action       text NOT NULL,
  changes      jsonb NOT NULL DEFAULT '{}',
  actor_type   text NOT NULL DEFAULT 'user',
  actor_id     bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_events (workspace_id, entity_type, entity_id, created_at DESC);
CREATE INDEX audit_created ON audit_events USING brin (created_at);

-- ───────────── Custom fields ─────────────
CREATE TABLE field_definitions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id       bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type        text NOT NULL CHECK (entity_type IN ('lead','deal','contact','company','product')),
  key                text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label              text NOT NULL,
  type               text NOT NULL CHECK (type IN ('text','textarea','number','money','date','datetime','boolean','select','multiselect','url','user')),
  options            jsonb NOT NULL DEFAULT '[]',
  required           text NOT NULL DEFAULT 'never' CHECK (required IN ('never','always','from_stage')),
  required_stage_ids bigint[] NOT NULL DEFAULT '{}',
  help_text          text,
  sort               int NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, key)
);

-- ───────────── Automation, jobs, notifications, views ─────────────
CREATE TABLE automation_rules (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('lead','deal')),
  pipeline_id   bigint NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id      bigint REFERENCES stages(id) ON DELETE CASCADE,
  trigger       text NOT NULL CHECK (trigger IN ('stage_entered','created')),
  delay_minutes int NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
  conditions    jsonb NOT NULL DEFAULT '[]',
  action        text NOT NULL CHECK (action IN ('create_activity','notify','add_note','update_field','assign_owner','move_stage')),
  config        jsonb NOT NULL DEFAULT '{}',
  is_enabled    boolean NOT NULL DEFAULT true,
  sort          int NOT NULL DEFAULT 0,
  created_by    bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_rules_lookup ON automation_rules (workspace_id, entity_type, pipeline_id, trigger) WHERE is_enabled;

CREATE TABLE automation_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id       bigint REFERENCES automation_rules(id) ON DELETE SET NULL,
  entity_type   text NOT NULL,
  entity_id     bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('scheduled','success','skipped','failed')),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  message       text,
  depth         smallint NOT NULL DEFAULT 0
);
CREATE INDEX automation_runs_entity ON automation_runs (entity_type, entity_id, scheduled_for DESC);

CREATE TABLE outbox_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    bigint NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  depth        smallint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (id) WHERE processed_at IS NULL;

CREATE TABLE jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  run_at      timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text,
  entity_type  text,
  entity_id    bigint,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE saved_views (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id     bigint REFERENCES users(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  name         text NOT NULL,
  query        jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

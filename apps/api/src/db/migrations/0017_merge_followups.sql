-- Merge leads (like contacts and companies), and "similar name" duplicate detection.
ALTER TABLE leads ADD COLUMN merged_into_id bigint REFERENCES leads(id) ON DELETE SET NULL;

-- Name keys for fuzzy matching: lower case, punctuation removed, spaces collapsed; companies also drop legal forms and
-- filler words ("Acme Robotics Ltd." ≈ "ACME Robotics"). IMMUTABLE so they can be indexed.
CREATE FUNCTION crm_person_key(first text, last text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(regexp_replace(lower(coalesce(first, '') || ' ' || coalesce(last, '')), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;
CREATE FUNCTION crm_company_key(name text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(name, '')), '[^[:alnum:]]+', ' ', 'g'),
    '\m(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|corp|corporation|co|company|sa|sas|ag|bv|nv|pte|pty|the|and|group)\M', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;
CREATE INDEX contacts_namekey_trgm ON contacts USING gin (crm_person_key(first_name, last_name) gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX leads_namekey_trgm ON leads USING gin (crm_person_key(first_name, last_name) gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX companies_namekey_trgm ON companies USING gin (crm_company_key(name) gin_trgm_ops) WHERE deleted_at IS NULL;

ALTER TABLE duplicate_dismissals DROP CONSTRAINT IF EXISTS duplicate_dismissals_entity_type_check;
ALTER TABLE duplicate_dismissals ADD CONSTRAINT duplicate_dismissals_entity_type_check CHECK (entity_type IN ('contact','company','lead'));

-- Pipeline-level access: NULL = every role; otherwise only these roles (admins always have access).
ALTER TABLE pipelines ADD COLUMN allowed_role_ids bigint[];

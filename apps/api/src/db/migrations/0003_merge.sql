-- Merging duplicate contacts / companies. The merged-away record is soft-deleted and points at the record it was
-- merged into, so old links can say where it went (and the recycle bin can leave it out).
ALTER TABLE contacts  ADD COLUMN merged_into_id bigint REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN merged_into_id bigint REFERENCES companies(id) ON DELETE SET NULL;

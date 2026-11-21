-- Round-robin booking pages: several team members share one link. A time is offered when any of them is free; each
-- booking goes to a free one, taking turns. team_ids lists them in order (host_id stays the first, for older code);
-- empty = a page for one person.
ALTER TABLE booking_pages ADD COLUMN team_ids bigint[] NOT NULL DEFAULT '{}';

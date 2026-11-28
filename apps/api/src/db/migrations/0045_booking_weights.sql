-- Weighted round-robin: each person on a shared booking page gets a share (1–10, default 1), e.g. Rita 2 and Otto 1
-- means Rita gets about twice as many bookings. team_weights lines up with team_ids; empty = everyone 1.
ALTER TABLE booking_pages ADD COLUMN team_weights int[] NOT NULL DEFAULT '{}';
ALTER TABLE booking_pages ADD CONSTRAINT booking_pages_team_weights_len
  CHECK (cardinality(team_weights) = 0 OR cardinality(team_weights) = cardinality(team_ids));
ALTER TABLE booking_pages ADD CONSTRAINT booking_pages_team_weights_range
  CHECK (1 <= ALL(team_weights) AND 10 >= ALL(team_weights));

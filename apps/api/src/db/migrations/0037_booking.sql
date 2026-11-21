-- Online booking: public pages (/book/<slug>) where customers pick a free time with a team member. A booking creates
-- (or finds) the contact, a meeting for the host (with a video-call link if the page offers one) and a confirmation
-- email with a calendar file and a cancel link.
CREATE TABLE booking_pages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug             text NOT NULL UNIQUE,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  host_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  days             int[] NOT NULL DEFAULT '{1,2,3,4,5}',
  start_time       text NOT NULL DEFAULT '09:00',
  end_time         text NOT NULL DEFAULT '17:00',
  min_notice_hours int NOT NULL DEFAULT 4,
  days_ahead       int NOT NULL DEFAULT 30,
  video            boolean NOT NULL DEFAULT true,
  location         text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_pages_ws ON booking_pages (workspace_id);

CREATE TABLE bookings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id      bigint REFERENCES booking_pages(id) ON DELETE SET NULL,
  host_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  activity_id  bigint REFERENCES activities(id) ON DELETE SET NULL,
  contact_id   bigint REFERENCES contacts(id) ON DELETE SET NULL,
  call_id      bigint REFERENCES calls(id) ON DELETE SET NULL,
  title        text NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  name         text NOT NULL,
  email        text NOT NULL,
  phone        text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  token_hash   text NOT NULL UNIQUE,      -- the customer's manage/cancel link
  status       text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'canceled')),
  canceled_by  text CHECK (canceled_by IN ('customer', 'team')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_host_time ON bookings (host_id, starts_at) WHERE status = 'booked';
CREATE INDEX bookings_page ON bookings (page_id, starts_at);

-- A call planned for later (a booked meeting) stays open until a day after its time, not a day after it was made.
ALTER TABLE calls ADD COLUMN scheduled_for timestamptz;

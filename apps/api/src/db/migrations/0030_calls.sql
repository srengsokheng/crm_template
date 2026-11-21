-- Video calls in the app (WebRTC, peer to peer). A call may belong to a meeting activity or an Inbox conversation.
-- Customers join with a guest link (the token is only stored hashed). Call set-up messages (offers, answers, network
-- candidates) go through call_signals because they can be larger than a NOTIFY payload; they're deleted after a day.
CREATE TABLE calls (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            text NOT NULL,
  activity_id      bigint REFERENCES activities(id) ON DELETE SET NULL,
  conversation_id  bigint REFERENCES conversations(id) ON DELETE SET NULL,
  guest_token_hash text NOT NULL UNIQUE,
  -- The same token encrypted (SECRETS_KEY), so the team can copy the guest link again.
  guest_token_sealed text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ended')),
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  ended_at         timestamptz
);
CREATE INDEX calls_workspace ON calls (workspace_id, created_at DESC);

CREATE TABLE call_peers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id     bigint NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  -- Random id other participants address this one by, and the hashed secret its browser proves itself with.
  peer_id     text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  name        text NOT NULL,
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz
);
CREATE INDEX call_peers_call ON call_peers (call_id) WHERE left_at IS NULL;

CREATE TABLE call_signals (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id    bigint NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  from_peer  text NOT NULL,
  to_peer    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('offer','answer','candidate')),
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

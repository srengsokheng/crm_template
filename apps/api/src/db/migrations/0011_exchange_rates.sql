-- Multi-currency reporting: admin-entered exchange rates. 1 unit of `currency` = `rate_to_base` units of the
-- workspace base currency, from `valid_from` until the next rate for that currency.
CREATE TABLE exchange_rates (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  currency     char(3) NOT NULL,
  rate_to_base numeric(18,8) NOT NULL CHECK (rate_to_base > 0),
  valid_from   date NOT NULL,
  created_by   bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, currency, valid_from)
);
CREATE INDEX exchange_rates_lookup ON exchange_rates (workspace_id, currency, valid_from DESC);

-- Amount in the base currency on a given day; NULL when no rate is known (so sums never mix currencies silently).
CREATE FUNCTION crm_to_base(amount numeric, currency char(3), base char(3), ws bigint, at date) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN amount IS NULL THEN NULL
    WHEN currency = base THEN amount
    ELSE round(amount * (SELECT r.rate_to_base FROM exchange_rates r
                         WHERE r.workspace_id = ws AND r.currency = crm_to_base.currency AND r.valid_from <= at
                         ORDER BY r.valid_from DESC LIMIT 1), 2)
  END
$$;

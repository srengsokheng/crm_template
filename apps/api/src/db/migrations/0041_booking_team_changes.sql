-- The team can move or cancel a booking from the CRM, and the customer is emailed. For that:
-- - the customer's link is also kept encrypted (SECRETS_KEY), so team emails can include it (older bookings: no link);
-- - the calendar file's version (SEQUENCE) gets its own counter: team moves don't count against the customer's 3 moves.
ALTER TABLE bookings ADD COLUMN token_sealed text;
ALTER TABLE bookings ADD COLUMN ics_sequence int NOT NULL DEFAULT 0;
UPDATE bookings SET ics_sequence = reschedules + CASE WHEN status = 'canceled' THEN 1 ELSE 0 END;

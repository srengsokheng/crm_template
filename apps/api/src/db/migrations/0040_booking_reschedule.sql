-- Customers can move a booking to another free time from their link (up to 3 times); the count is kept here and used
-- as the calendar file's SEQUENCE, so calendar apps replace the old entry.
ALTER TABLE bookings ADD COLUMN reschedules int NOT NULL DEFAULT 0;

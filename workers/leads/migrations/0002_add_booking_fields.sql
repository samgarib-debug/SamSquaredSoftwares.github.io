-- Demo bookings from /book. A booking is a lead with a type (online demo or
-- on-site call-out), the slot it starts in, a phone number for the WhatsApp
-- confirmation and, for call-outs, the venue address. All nullable, so rows
-- from the contact form are unchanged and this applies safely before the new
-- code deploys.
ALTER TABLE leads ADD COLUMN phone TEXT;
ALTER TABLE leads ADD COLUMN booking_type TEXT;
ALTER TABLE leads ADD COLUMN booking_slot TEXT;
ALTER TABLE leads ADD COLUMN address TEXT;

CREATE INDEX leads_booking_slot ON leads (booking_slot) WHERE booking_slot IS NOT NULL;

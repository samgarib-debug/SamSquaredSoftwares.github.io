# Lead capture Worker

Stores every demo request from `contact.html` and every demo booking from `/book` in a Cloudflare D1 database. It can also ping Slack, and copy each lead into HubSpot as a contact plus a deal.

## How it works

1. A visitor submits the contact form.
2. `script.js` sends a copy of the form to `POST /api/lead` with `navigator.sendBeacon`. The beacon never blocks or delays the real submission.
3. The form still posts to FormSubmit, which emails info@ as before.
4. This Worker runs on `samsquaredsoftwares.com/api/*` and `www.samsquaredsoftwares.com/api/*`. Every other path still goes to GitHub Pages. For each lead it:
   - accepts only requests from our own site (`Origin` check)
   - rate-limits to 5 requests a minute per IP
   - drops bots that fill in the hidden `_honey` field
   - validates the fields and caps the body at 64 KB
   - stores the lead once, skipping a repeat of the same email and message within 10 minutes, and retries D1 writes that fail with a transient error
   - posts to Slack, if `SLACK_WEBHOOK_URL` is set
   - copies it into HubSpot as a contact plus a deal, if `HUBSPOT_TOKEN` is set (see step 5)

If the Worker is down or not deployed yet, the beacon fails quietly. The email still goes out.

### Demo bookings from /book

`book.html` posts straight to `POST /api/lead` with `fetch` (no FormSubmit). On top of the contact fields it sends:

| Field | Rule |
|-------|------|
| `type` | `online` (30 min demo) or `onsite` (60 min call-out) |
| `slot` | start time as `YYYY-MM-DDTHH:MM+02:00`, Monday to Friday, not a South African public holiday, 09:00 to 17:00 SAST, on the half hour (online) or hour (on-site), in the future and at most 15 days ahead |
| `phone` | required for bookings, 9 to 15 digits |
| `venue` | required for bookings |
| `address` | required for `onsite`, dropped for `online` |

A stored booking answers `201` with `{"ok": true, "booking": {...}}`, so `book.js` can tell it apart from an older Worker that would drop the slot and answer `204`. A bad slot answers `400` with `{"error": "invalid_slot", "field": "slot", "reason": "..."}`. If the Worker is unreachable, `/book` shows the visitor a WhatsApp and email fallback with the booking typed out.

The public holiday rules live in `src/booking.js` and again in `/book.js` on the site. Days the President declares later (such as election days) go in the `DECLARED` list in both files.

This is the interim booking flow: a person confirms each slot by WhatsApp or email within one business day. Instant confirmation will come from the SAMePOS booking module later.

## One-time setup

### 1. Create a Cloudflare API token

Create it in **the Cloudflare account that holds `samsquaredsoftwares.com`**: My Profile > API Tokens > Create Token > Custom token. It needs these permissions:

| Scope   | Permission         | Access |
|---------|--------------------|--------|
| Account | Workers Scripts    | Edit   |
| Account | D1                 | Edit   |
| Account | Account Settings   | Read   |
| Zone    | Workers Routes     | Edit   |
| Zone    | Zone               | Read   |

Set **Account Resources** to that one account, and **Zone Resources** to `samsquaredsoftwares.com`.

### 2. Add it to GitHub

Go to repo Settings > Secrets and variables > Actions > New repository secret:

- `CLOUDFLARE_API_TOKEN`: the token from step 1.
- `CLOUDFLARE_ACCOUNT_ID`: optional. Only needed if the token can see more than one account.

### 3. Deploy

Go to Actions > **Deploy lead Worker** > Run workflow. After that, every push to `main` that changes `workers/leads/` redeploys it. The workflow:

1. runs the tests
2. creates the `samsquared-leads` D1 database if it doesn't exist yet (in Western Europe, the closest location to South Africa)
3. applies the migrations
4. deploys

Always deploy through this workflow, never a bare `wrangler deploy`. On a fresh account, a bare deploy creates the database in the wrong place and without the `leads` table.

If the zone is in a different account from the token, the deploy fails with "Could not find zone". Make the token in the other account.

### 4. Optional: Slack alerts

1. Create a Slack incoming webhook for the channel you want.
2. In the Cloudflare dashboard, go to Workers & Pages > `samsquared-leads` > Settings > Variables and Secrets.
3. Add a **secret** named `SLACK_WEBHOOK_URL` with the webhook URL.

### 5. Optional: HubSpot (contact plus deal for every lead)

After a lead is stored, the Worker copies it into HubSpot in the background (`src/hubspot.js`, CRM v3 REST):

1. **Contact**, matched by email: it updates the existing contact (`PATCH /crm/v3/objects/contacts/{email}?idProperty=email`), or creates one if there is none, so a repeat visitor is never duplicated. It sends only what the visitor typed: first and last name, email, phone and company (the venue).
2. **Deal**, associated with that contact: named `<venue> · demo`, `<venue> · call-out`, or `<venue> · enquiry` for the contact form. It goes into the first stage of the default sales pipeline (looked up once with `GET /crm/v3/pipelines/deals`). The description holds the slot in words, the type, the raw slot, the address for call-outs, the phone, the notes and the D1 lead id.

This runs after the visitor already has their answer. If the token is missing, HubSpot is down or refuses the call, the lead is still in D1 and the visitor still sees success. The Worker logs `hubspot.synced`, `hubspot.skipped` or `hubspot.failed` with the D1 row id, the step (`contact`, `pipeline` or `deal`) and the HTTP status. It never logs the token or the visitor's details. A lead that failed can be re-entered from D1.

**Set it up:**

1. In HubSpot, create a private app (Settings > Integrations > Private Apps > Create a private app). On its Scopes tab, tick:

   | Scope | Why |
   |-------|-----|
   | `crm.objects.contacts.read` | find the existing contact by email |
   | `crm.objects.contacts.write` | create or update the contact |
   | `crm.objects.deals.read` | read the deal pipeline to find its first stage |
   | `crm.objects.deals.write` | create the deal and link it to the contact |

2. Create the app and copy its access token (it starts with `pat-`).
3. Deploy the Worker first (step 3), then add the token as a secret. From this folder:

   ```sh
   cd workers/leads
   npx wrangler secret put HUBSPOT_TOKEN
   ```

   Paste the token when asked. If your Cloudflare login can see more than one account, run it as `CLOUDFLARE_ACCOUNT_ID=<the account that holds samsquaredsoftwares.com> npx wrangler secret put HUBSPOT_TOKEN`. You can also add it in the Cloudflare dashboard: Workers & Pages > `samsquared-leads` > Settings > Variables and Secrets > Add > type Secret, name `HUBSPOT_TOKEN`. A secret takes effect straight away, with no redeploy.
4. Send a test booking from `/book`, then check HubSpot for the contact and deal, and the Worker logs for `hubspot.synced`.

If the logs show `hubspot.failed` with step `pipeline` and status 403, the app can't read pipelines. Either add the scope, or skip the lookup: add `HUBSPOT_DEAL_STAGE` (the stage's internal ID, from Settings > Objects > Deals > Pipelines) and, for a pipeline other than the default one, `HUBSPOT_PIPELINE` to `vars` in `wrangler.jsonc`. Put them there rather than in the dashboard, because each deploy replaces dashboard variables with the ones in that file (secrets are kept).

## Reading leads

Open the Cloudflare dashboard > Storage & Databases > D1 > `samsquared-leads` > Console, and run:

```sql
SELECT created_at, name, email, venue, interest, message
FROM leads
ORDER BY created_at DESC
LIMIT 50;
```

Upcoming demo bookings (slots are in SAST, as the visitor picked them):

```sql
SELECT booking_slot, booking_type, name, venue, phone, email, address, message
FROM leads
WHERE booking_slot IS NOT NULL AND booking_slot >= strftime('%Y-%m-%dT%H:%M', 'now', '+2 hours')
ORDER BY booking_slot;
```

Or from this folder:

```sh
npx wrangler d1 execute DB --remote --command "SELECT * FROM leads ORDER BY created_at DESC LIMIT 50"
```

`created_at` is in UTC.

## Privacy

The Worker stores only:
- what the visitor typed (for bookings this includes a phone number and, for call-outs, the venue address)
- the page the form was on
- a two-letter country code

When `HUBSPOT_TOKEN` is set, the name, email, phone, venue, booking details and notes are also copied into HubSpot, which keeps its data outside South Africa. The privacy policy should say so before the token is turned on.

It stores no IP addresses and no user agents. The rate limiter sees the IP only in memory. Workers invocation logs and traces are turned off in `wrangler.jsonc`, because they would record each visitor's user agent, city and network next to the lead. The Worker's own log lines hold only an event name, the row ID and the country code. To remove someone's data:

```sql
DELETE FROM leads WHERE email = 'person@example.com';
```

## Development

```sh
npm install
npm test        # runs the Worker in workerd with a local D1; no Cloudflare account needed
```

To change the schema, add a new numbered file in `migrations/`. Never edit one that has already been applied. Keep changes additive, such as new nullable columns, because migrations run just before the new code deploys.

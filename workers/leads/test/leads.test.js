import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { publicHolidays } from '../src/booking.js';

const SITE = 'https://samsquaredsoftwares.com';
const ENDPOINT = SITE + '/api/lead';

// Rate limiter and D1 state persist across tests in this file, so every test
// uses its own IP and email.
let seq = 0;
function uniq() {
  seq += 1;
  return { ip: `192.0.2.${seq}`, email: `lead${seq}@venue.test` };
}

function fields(overrides = {}) {
  return {
    name: 'Ada Lovelace',
    email: 'ada@venue.test',
    venue: 'The Engine Room',
    interest: 'Full POS',
    message: 'Two bars, one kitchen.',
    _honey: '',
    ...overrides,
  };
}

function formData(values) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.append(key, value);
  return fd;
}

function post({ body, ip = '192.0.2.250', origin = SITE, referer = SITE + '/contact.html', headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
  if (origin !== null) h.Origin = origin;
  if (referer !== null) h.Referer = referer;
  return exports.default.fetch(ENDPOINT, { method: 'POST', headers: h, body });
}

async function rowsFor(email) {
  const { results } = await env.DB.prepare('SELECT * FROM leads WHERE email = ?1').bind(email).all();
  return results;
}

let slack;
beforeEach(() => {
  slack = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('storing leads', () => {
  it('stores a multipart submission, like the sendBeacon from script.js', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email })) });

    expect(res.status).toBe(204);
    const [row] = await rowsFor(email);
    expect(row).toMatchObject({
      name: 'Ada Lovelace',
      email,
      venue: 'The Engine Room',
      interest: 'Full POS',
      message: 'Two bars, one kitchen.',
      source: '/contact.html',
      phone: null,
      booking_type: null,
      booking_slot: null,
      address: null,
    });
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('ignores booking-only fields on a contact lead', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email, address: '1 Long St' })) });

    expect(res.status).toBe(204);
    const [row] = await rowsFor(email);
    expect(row.address).toBeNull();
  });

  it('stores a url-encoded submission', async () => {
    const { ip, email } = uniq();
    const res = await post({
      ip,
      body: new URLSearchParams(fields({ email })),
    });

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it('accepts the www origin', async () => {
    const { ip, email } = uniq();
    const www = 'https://www.samsquaredsoftwares.com';
    const res = await post({ ip, origin: www, referer: www + '/contact.html', body: formData(fields({ email })) });

    expect(res.status).toBe(204);
    const [row] = await rowsFor(email);
    expect(row.source).toBe('/contact.html');
  });

  it('trims values and stores empty optional fields as NULL', async () => {
    const { ip, email } = uniq();
    const res = await post({
      ip,
      body: formData(fields({ name: '  Grace  ', email: ` ${email} `, venue: '', interest: '', message: '   ' })),
    });

    expect(res.status).toBe(204);
    const [row] = await rowsFor(email);
    expect(row).toMatchObject({ name: 'Grace', venue: null, interest: null, message: null });
  });

  it('does not trust a Referer from another site', async () => {
    const { ip, email } = uniq();
    await post({ ip, referer: 'https://evil.test/contact.html', body: formData(fields({ email })) });

    const [row] = await rowsFor(email);
    expect(row.source).toBeNull();
  });

  it('stores a double submit once and pings Slack once', async () => {
    const { ip, email } = uniq();
    const first = await post({ ip, body: formData(fields({ email })) });
    const second = await post({ ip, body: formData(fields({ email })) });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(1);
    await vi.waitFor(() => expect(slack).toHaveBeenCalledTimes(1));
  });

  it('stores a second, different message from the same person', async () => {
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email, message: 'First' })) });
    await post({ ip, body: formData(fields({ email, message: 'Follow-up' })) });

    expect(await rowsFor(email)).toHaveLength(2);
  });

  it('stores a long message in full: only the body cap bounds it', async () => {
    const { ip, email } = uniq();
    const message = 'x'.repeat(20000);
    const res = await post({ ip, body: formData(fields({ email, message })) });

    expect(res.status).toBe(204);
    const [row] = await rowsFor(email);
    expect(row.message).toBe(message);
  });

  it('stores CRLF and CR line breaks as LF', async () => {
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email, message: 'Line one\r\nLine two\rLine three' })) });

    const [row] = await rowsFor(email);
    expect(row.message).toBe('Line one\nLine two\nLine three');
  });

  it('accepts a full form in a 3-byte script', async () => {
    const { ip, email } = uniq();
    const res = await post({
      ip,
      body: formData(fields({ email, name: '名'.repeat(200), venue: '店'.repeat(200), message: '字'.repeat(5000) })),
    });

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it('treats two empty messages as the same submission', async () => {
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email, message: '' })) });
    await post({ ip, body: formData(fields({ email, message: '' })) });

    expect(await rowsFor(email)).toHaveLength(1);
  });
});

describe('Slack alert', () => {
  it('posts the lead to the webhook', async () => {
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email })) });

    await vi.waitFor(() => expect(slack).toHaveBeenCalledTimes(1));
    const [url, init] = slack.mock.calls[0];
    expect(String(url)).toBe('https://hooks.slack.test/services/T000/B000/XXX');
    const { text } = JSON.parse(init.body);
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain(email);
    expect(text).toContain('The Engine Room | Full POS');
    expect(text).toContain('> Two bars, one kitchen.');
  });

  it('escapes Slack control characters so visitors cannot ping @channel', async () => {
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email, name: '<!channel> & <https://x.test|click>' })) });

    await vi.waitFor(() => expect(slack).toHaveBeenCalledTimes(1));
    const { text } = JSON.parse(slack.mock.calls[0][1].body);
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;https://x.test|click&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('never logs the webhook URL when Slack fails', async () => {
    slack.mockRejectedValue(new TypeError('Invalid URL: hooks.slack.test/services/T000/B000/XXX'));
    const logs = vi.spyOn(console, 'log');
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email })) });

    await vi.waitFor(() => expect(logs.mock.calls.flat().join('\n')).toContain('slack.failed'));
    expect(logs.mock.calls.flat().join('\n')).not.toContain('hooks.slack');
  });

  it('still stores the lead when Slack is down', async () => {
    slack.mockRejectedValue(new Error('network down'));
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email })) });

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(1);
  });
});

// A slot the /book page would offer: the next weekday that is not a public
// holiday, at least two days out, so the test does not depend on the clock.
function openDay(minDaysAhead = 2, skip = 0) {
  const sast = Date.now() + 2 * 3600 * 1000;
  let found = 0;
  for (let i = minDaysAhead; i < 15; i++) {
    const day = new Date(sast + i * 86400 * 1000);
    const iso = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6 || publicHolidays(day.getUTCFullYear()).has(iso)) continue;
    if (found++ === skip) return iso;
  }
  throw new Error('no open day found');
}

function nextWeekend() {
  const sast = Date.now() + 2 * 3600 * 1000;
  for (let i = 1; i < 8; i++) {
    const day = new Date(sast + i * 86400 * 1000);
    if (day.getUTCDay() === 6) return day.toISOString().slice(0, 10);
  }
  throw new Error('unreachable');
}

function booking(overrides = {}) {
  return fields({
    interest: 'Online demo (30 min)',
    message: 'Two bars, one kitchen.',
    phone: '+27 64 000 0000',
    type: 'online',
    slot: `${openDay()}T10:00+02:00`,
    day: openDay(),
    ...overrides,
  });
}

// Reads the body every time: workerd complains about responses left unread.
async function postBooking(values, ip) {
  const res = await post({ ip, referer: SITE + '/book', body: formData(values) });
  const body = await res.text();
  return { status: res.status, json: () => JSON.parse(body) };
}

describe('bookings from /book', () => {
  it('stores an online demo and answers 201 with the booking', async () => {
    const { ip, email } = uniq();
    const slot = `${openDay()}T09:30+02:00`;
    const res = await postBooking(booking({ email, slot, address: 'should be dropped' }), ip);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, booking: { type: 'online', slot } });
    const [row] = await rowsFor(email);
    expect(row).toMatchObject({
      name: 'Ada Lovelace',
      venue: 'The Engine Room',
      phone: '+27 64 000 0000',
      booking_type: 'online',
      booking_slot: slot,
      address: null,
      message: 'Two bars, one kitchen.',
      source: '/book',
    });
  });

  it('stores an on-site call-out with its address', async () => {
    const { ip, email } = uniq();
    const slot = `${openDay()}T14:00+02:00`;
    const res = await postBooking(booking({ email, type: 'onsite', slot, address: '1 Long St\r\nCape Town' }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(row).toMatchObject({ booking_type: 'onsite', booking_slot: slot, address: '1 Long St\nCape Town' });
  });

  it.each([
    ['type', { type: '' }, 'missing_field'],
    ['type', { type: 'phone-call' }, 'invalid_type'],
    ['slot', { slot: '' }, 'missing_field'],
    ['venue', { venue: '' }, 'missing_field'],
    ['phone', { phone: '' }, 'missing_field'],
    ['address', { type: 'onsite', slot: '', address: '' }, 'missing_field'],
    ['address', { address: 'x'.repeat(301) }, 'field_too_long'],
  ])('rejects a booking with a bad %s (%o)', async (field, override, error) => {
    const { ip, email } = uniq();
    const values = booking({ email, ...override });
    if (override.type === 'onsite') values.slot = `${openDay()}T10:00+02:00`;
    const res = await postBooking(values, ip);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error, field });
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it.each([
    ['a weekend', () => `${nextWeekend()}T10:00+02:00`, 'weekend'],
    ['election day', () => '2026-11-04T10:00+02:00', 'public_holiday'],
    ['before 09:00', () => `${openDay()}T08:30+02:00`, 'outside_hours'],
    ['a call-out starting at 17:00', () => `${openDay()}T17:00+02:00`, 'outside_hours', 'onsite'],
    ['quarter past', () => `${openDay()}T09:15+02:00`, 'off_grid'],
    ['a past day', () => '2026-01-05T10:00+02:00', 'in_the_past'],
    ['a month out', () => {
      const day = new Date(Date.now() + 40 * 86400 * 1000);
      while ([0, 6].includes(day.getUTCDay()) || publicHolidays(day.getUTCFullYear()).has(day.toISOString().slice(0, 10))) {
        day.setUTCDate(day.getUTCDate() + 1);
      }
      return `${day.toISOString().slice(0, 10)}T10:00+02:00`;
    }, 'too_far_ahead'],
    ['UTC time', () => `${openDay()}T10:00Z`, 'bad_format'],
  ])('refuses a slot on %s', async (_, makeSlot, reason, type = 'online') => {
    const { ip, email } = uniq();
    const res = await postBooking(booking({ email, type, slot: makeSlot(), address: '1 Long St' }), ip);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_slot', field: 'slot', reason });
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('stores a double-clicked booking once, and a second slot separately', async () => {
    const { ip, email } = uniq();
    const first = await postBooking(booking({ email }), ip);
    const again = await postBooking(booking({ email }), ip);
    const other = await postBooking(booking({ email, slot: `${openDay(2, 1)}T11:00+02:00` }), ip);

    expect([first.status, again.status, other.status]).toEqual([201, 201, 201]);
    expect(await rowsFor(email)).toHaveLength(2);
    await vi.waitFor(() => expect(slack).toHaveBeenCalledTimes(2));
  });

  it('drops a booking from the honeypot quietly', async () => {
    const { ip, email } = uniq();
    const res = await postBooking(booking({ email, _honey: 'bot' }), ip);

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('tells Slack it is a booking, with the slot, phone and address', async () => {
    const { ip, email } = uniq();
    const day = openDay();
    await postBooking(booking({ email, type: 'onsite', slot: `${day}T15:00+02:00`, address: '1 Long St\nCape Town' }), ip);

    await vi.waitFor(() => expect(slack).toHaveBeenCalledTimes(1));
    const { text } = JSON.parse(slack.mock.calls[0][1].body);
    expect(text).toContain('*New demo booking* from Ada Lovelace');
    expect(text).toMatch(/On-site call-out \(60 min\), \w{3} \d{1,2} \w{3} \d{4} at 15:00 SAST/);
    expect(text).toContain('The Engine Room | +27 64 000 0000');
    expect(text).toContain('Address: 1 Long St, Cape Town');
    expect(text).toContain('> Two bars, one kitchen.');
  });
});

describe('spam and abuse', () => {
  it('drops honeypot hits quietly: 204, nothing stored, no Slack', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email, _honey: 'https://spam.test' })) });

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(0);
    expect(slack).not.toHaveBeenCalled();
  });

  it('rejects requests from other sites', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, origin: 'https://evil.test', body: formData(fields({ email })) });

    expect(res.status).toBe(403);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('rejects requests with no Origin, such as curl', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, origin: null, body: formData(fields({ email })) });

    expect(res.status).toBe(403);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('rejects the opaque "null" origin', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, origin: 'null', body: formData(fields({ email })) });

    expect(res.status).toBe(403);
  });

  it('rate limits one IP after 5 requests a minute', async () => {
    const { ip } = uniq();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await post({ ip, body: formData(fields({ email: `burst${i}@venue.test` })) });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);

    const other = await post({ ip: uniq().ip, body: formData(fields({ email: uniq().email })) });
    expect(other.status).toBe(204);
  });

  it('refuses a body over 64 KB by its Content-Length', async () => {
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email, message: 'x'.repeat(70000) })) });

    expect(res.status).toBe(413);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('refuses a streamed body over 64 KB with no Content-Length', async () => {
    const { ip } = uniq();
    // Finite (about 72 KB), so a broken cap fails this test instead of hanging.
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ < 18) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await post({
      ip,
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(413);
  });
});

describe('validation', () => {
  it.each([
    ['name', { name: '' }, 'missing_field'],
    ['email', { email: '' }, 'missing_field'],
    ['email', { email: 'not-an-email' }, 'invalid_email'],
    ['name', { name: 'x'.repeat(201) }, 'field_too_long'],
    ['venue', { venue: 'x'.repeat(201) }, 'field_too_long'],
    ['interest', { interest: 'x'.repeat(101) }, 'field_too_long'],
    ['phone', { phone: '1'.repeat(41) }, 'field_too_long'],
    ['phone', { phone: 'call me' }, 'invalid_phone'],
    ['phone', { phone: '082 123' }, 'invalid_phone'],
  ])('rejects a bad %s (%o)', async (field, override, error) => {
    const { ip, email } = uniq();
    const res = await post({ ip, body: formData(fields({ email, ...override })) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error, field });
  });

  it('accepts every field at its maximum length', async () => {
    const { ip } = uniq();
    const email = 'a'.repeat(240) + '@venue.test'; // 251 chars, under 254
    const res = await post({
      ip,
      body: formData(fields({
        email,
        name: 'n'.repeat(200),
        venue: 'v'.repeat(200),
        interest: 'i'.repeat(100),
        message: 'm'.repeat(5000),
      })),
    });

    expect(res.status).toBe(204);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it('rejects a JSON body', async () => {
    const { ip } = uniq();
    const res = await post({
      ip,
      body: JSON.stringify(fields()),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unreadable_body' });
  });
});

describe('logging', () => {
  it('logs the row id for a stored lead and none for a duplicate', async () => {
    const logs = vi.spyOn(console, 'log');
    const { ip, email } = uniq();
    await post({ ip, body: formData(fields({ email })) });
    await post({ ip, body: formData(fields({ email })) });

    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    const [stored] = await rowsFor(email);
    expect(events).toContainEqual({ event: 'lead.stored', id: stored.id, country: null });
    expect(events).toContainEqual({ event: 'lead.duplicate', country: null });
  });
});

// D1 does not retry writes itself. These call the Worker directly with a
// database that fails on purpose.
describe('D1 write retries', () => {
  function flakyDb(errors) {
    const db = {
      calls: 0,
      prepare(sql) {
        const real = env.DB.prepare(sql);
        return {
          bind(...args) {
            const bound = real.bind(...args);
            return {
              async run() {
                db.calls += 1;
                const err = errors.shift();
                if (err) throw err;
                return bound.run();
              },
            };
          },
        };
      },
    };
    return db;
  }

  async function direct(db, values, ip) {
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { Origin: SITE, 'CF-Connecting-IP': ip },
      body: formData(values),
    });
    const testEnv = {
      DB: db,
      LEAD_LIMITER: env.LEAD_LIMITER,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL,
    };
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('retries a transient error and stores the lead', async () => {
    const db = flakyDb([new Error('D1_ERROR: Network connection lost.')]);
    const { ip, email } = uniq();
    const res = await direct(db, fields({ email }), ip);

    expect(res.status).toBe(204);
    expect(db.calls).toBe(2);
    expect(await rowsFor(email)).toHaveLength(1);
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts with a 503', async () => {
    const lost = () => new Error('D1_ERROR: Network connection lost.');
    const db = flakyDb([lost(), lost(), lost()]);
    const { ip, email } = uniq();
    const res = await direct(db, fields({ email }), ip);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'store_failed' });
    expect(db.calls).toBe(3);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('does not retry an error that is not transient', async () => {
    const db = flakyDb([new Error('D1_ERROR: no such table: leads')]);
    const { ip, email } = uniq();
    const res = await direct(db, fields({ email }), ip);

    expect(res.status).toBe(503);
    expect(db.calls).toBe(1);
  });
});

describe('routing', () => {
  it('only allows POST', async () => {
    const res = await exports.default.fetch(ENDPOINT);

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    await res.text();
  });

  it('returns 404 for other /api paths', async () => {
    const res = await exports.default.fetch(SITE + '/api/other', { method: 'POST' });

    expect(res.status).toBe(404);
    await res.text();
  });
});

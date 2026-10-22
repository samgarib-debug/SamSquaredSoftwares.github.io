import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { publicHolidays } from '../src/booking.js';
import { resetHubSpotCache } from '../src/hubspot.js';

const SITE = 'https://samsquaredsoftwares.com';
const ENDPOINT = SITE + '/api/lead';
const API = 'https://api.hubapi.com';
const TOKEN = 'pat-test-token';

let seq = 0;
function uniq() {
  seq += 1;
  return { ip: `198.51.100.${seq}`, email: `hub${seq}@venue.test` };
}

// The next weekday that is not a public holiday, two or more days out.
function openDay() {
  const sast = Date.now() + 2 * 3600 * 1000;
  for (let i = 2; i < 15; i++) {
    const day = new Date(sast + i * 86400 * 1000);
    const iso = day.toISOString().slice(0, 10);
    if ([0, 6].includes(day.getUTCDay()) || publicHolidays(day.getUTCFullYear()).has(iso)) continue;
    return iso;
  }
  throw new Error('no open day found');
}

function formData(values) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.append(key, value);
  return fd;
}

function booking(overrides = {}) {
  return {
    name: 'Ada King Lovelace',
    email: 'ada@venue.test',
    venue: 'The Engine Room',
    phone: '+27 64 000 0000',
    type: 'online',
    slot: `${openDay()}T10:00+02:00`,
    message: 'Two bars, one kitchen.',
    _honey: '',
    ...overrides,
  };
}

// Calls the Worker with HUBSPOT_TOKEN set, and waits for the background work.
async function send(values, ip, extraEnv = {}) {
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { Origin: SITE, Referer: SITE + '/book', 'CF-Connecting-IP': ip },
    body: formData(values),
  });
  const testEnv = {
    DB: env.DB,
    LEAD_LIMITER: env.LEAD_LIMITER,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    HUBSPOT_TOKEN: TOKEN,
    ...extraEnv,
  };
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body };
}

async function rowsFor(email) {
  const { results } = await env.DB.prepare('SELECT * FROM leads WHERE email = ?1').bind(email).all();
  return results;
}

const PIPELINES = {
  results: [
    {
      id: 'b2b', label: 'Partners', displayOrder: 0, archived: false,
      stages: [{ id: 'partner-new', displayOrder: 0, archived: false }],
    },
    {
      id: 'default', label: 'Sales Pipeline', displayOrder: 1, archived: false,
      stages: [
        { id: 'qualifiedtobuy', displayOrder: 1, archived: false },
        { id: 'old-first', displayOrder: 0, archived: true },
        { id: 'appointmentscheduled', displayOrder: 0, archived: false },
      ],
    },
  ],
};

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// A fake HubSpot. `routes` maps "METHOD path-prefix" to a response maker.
let calls;
let logs;
function hubspot(routes) {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const call = {
      method,
      path: url.pathname + url.search,
      auth: new Headers(init.headers).get('Authorization'),
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (url.origin !== API) throw new Error('unexpected fetch to ' + url.origin);
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(' ');
      return m === method && call.path.startsWith(prefix);
    });
    if (!key) throw new Error(`no route for ${method} ${call.path}`);
    const route = routes[key];
    return typeof route === 'function' ? route(call) : route.clone();
  });
}

function events() {
  return logs.mock.calls.map(([line]) => JSON.parse(line));
}

beforeEach(() => {
  resetHubSpotCache();
  logs = vi.spyOn(console, 'log');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('HubSpot sync', () => {
  it('creates a new contact and a deal in the first stage of the default pipeline', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(404, { status: 'error', category: 'OBJECT_NOT_FOUND' }),
      'POST /crm/v3/objects/contacts': json(201, { id: '101' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '901' }),
    });
    const { ip, email } = uniq();
    const slot = `${openDay()}T14:00+02:00`;
    const res = await send(booking({ email, type: 'onsite', slot, address: '1 Long St\nCape Town' }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(row.booking_slot).toBe(slot);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH /crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
      'POST /crm/v3/objects/contacts',
      'GET /crm/v3/pipelines/deals',
      'POST /crm/v3/objects/deals',
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[1].body).toEqual({
      properties: { email, firstname: 'Ada', lastname: 'King Lovelace', phone: '+27 64 000 0000', company: 'The Engine Room' },
    });

    const deal = calls[3].body;
    expect(deal.properties).toMatchObject({
      dealname: 'The Engine Room · call-out',
      pipeline: 'default',
      dealstage: 'appointmentscheduled',
    });
    expect(deal.properties.description).toContain('On-site call-out (60 min)');
    expect(deal.properties.description).toContain('Type: onsite');
    expect(deal.properties.description).toContain(`Slot: ${slot}`);
    expect(deal.properties.description).toContain('Address: 1 Long St, Cape Town');
    expect(deal.properties.description).toContain('Notes: Two bars, one kitchen.');
    expect(deal.properties.description).toContain(`lead ${row.id} in D1`);
    expect(deal.associations).toEqual([
      { to: { id: '101' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
    ]);
    expect(events()).toContainEqual({ event: 'hubspot.synced', id: row.id, contact: '101', deal: '901' });
  });

  it('updates an existing contact instead of creating a duplicate', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '55' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '902' }),
    });
    const { ip, email } = uniq();
    const res = await send(booking({ email }), ip);

    expect(res.status).toBe(201);
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts')).toHaveLength(0);
    const deal = calls.find((c) => c.path === '/crm/v3/objects/deals').body;
    expect(deal.properties.dealname).toBe('The Engine Room · demo');
    expect(deal.properties.description).toContain('Online demo (30 min)');
    expect(deal.associations[0].to.id).toBe('55');
  });

  it('updates the contact someone created a moment earlier (409 on create)', async () => {
    let patches = 0;
    hubspot({
      'PATCH /crm/v3/objects/contacts/': () => (++patches === 1 ? json(404, {}) : json(200, { id: '77' })),
      'POST /crm/v3/objects/contacts': json(409, { message: 'Contact already exists' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '903' }),
    });
    const { ip, email } = uniq();
    await send(booking({ email }), ip);

    expect(patches).toBe(2);
    expect(calls.find((c) => c.path === '/crm/v3/objects/deals').body.associations[0].to.id).toBe('77');
  });

  it('copies a contact-form lead as an enquiry deal', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '56' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '904' }),
    });
    const { ip, email } = uniq();
    const values = { name: 'Grace', email, venue: 'Hopper Bar', interest: 'Full POS', message: 'Hi', _honey: '' };
    const res = await send(values, ip);

    expect(res.status).toBe(204);
    expect(calls[0].body.properties).toEqual({ email, firstname: 'Grace', company: 'Hopper Bar' });
    const deal = calls.find((c) => c.path === '/crm/v3/objects/deals').body;
    expect(deal.properties.dealname).toBe('Hopper Bar · enquiry');
    expect(deal.properties.description).toContain('Interested in: Full POS');
    expect(deal.properties.description).not.toContain('Slot:');
  });

  it('looks up the pipeline stage once per isolate', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '57' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '905' }),
    });
    const a = uniq();
    const b = uniq();
    await send(booking({ email: a.email }), a.ip);
    await send(booking({ email: b.email }), b.ip);

    expect(calls.filter((c) => c.path === '/crm/v3/pipelines/deals')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/crm/v3/objects/deals')).toHaveLength(2);
  });

  it('uses HUBSPOT_DEAL_STAGE when it is set, without a pipeline lookup', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '58' }),
      'POST /crm/v3/objects/deals': json(201, { id: '906' }),
    });
    const { ip, email } = uniq();
    await send(booking({ email }), ip, { HUBSPOT_DEAL_STAGE: '12345', HUBSPOT_PIPELINE: '678' });

    const deal = calls.find((c) => c.path === '/crm/v3/objects/deals').body;
    expect(deal.properties).toMatchObject({ pipeline: '678', dealstage: '12345' });
    expect(calls.some((c) => c.path.startsWith('/crm/v3/pipelines'))).toBe(false);
  });
});

describe('HubSpot trouble never blocks the form', () => {
  it('skips HubSpot and logs it when HUBSPOT_TOKEN is not set', async () => {
    hubspot({});
    const { ip, email } = uniq();
    const res = await exports.default.fetch(ENDPOINT, {
      method: 'POST',
      headers: { Origin: SITE, 'CF-Connecting-IP': ip },
      body: formData(booking({ email })),
    });

    expect(res.status).toBe(201);
    await res.text();
    const [row] = await rowsFor(email);
    expect(row).toBeTruthy();
    await vi.waitFor(() => expect(events()).toContainEqual({ event: 'hubspot.skipped', id: row.id, reason: 'no_token' }));
    expect(calls.filter((c) => c.path.startsWith('/crm'))).toHaveLength(0);
  });

  it('still saves the lead and answers 201 when HubSpot refuses the token (401)', async () => {
    hubspot({ 'PATCH /crm/v3/objects/contacts/': json(401, { category: 'INVALID_AUTHENTICATION' }) });
    const { ip, email } = uniq();
    const res = await send(booking({ email }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(row).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(events()).toContainEqual({ event: 'hubspot.failed', id: row.id, step: 'contact', status: 401, error: 'HubSpotError' });
  });

  it('logs a 5xx on the deal and still answers 201', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '59' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(502, { message: 'Bad gateway' }),
    });
    const { ip, email } = uniq();
    const res = await send(booking({ email }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(events()).toContainEqual({ event: 'hubspot.failed', id: row.id, step: 'deal', status: 502, error: 'HubSpotError' });
  });

  it('logs a failed pipeline lookup (missing scope) and creates no deal', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '60' }),
      'GET /crm/v3/pipelines/deals': json(403, { category: 'MISSING_SCOPES' }),
    });
    const { ip, email } = uniq();
    const res = await send(booking({ email }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(events()).toContainEqual({ event: 'hubspot.failed', id: row.id, step: 'pipeline', status: 403, error: 'HubSpotError' });
    expect(calls.some((c) => c.path === '/crm/v3/objects/deals')).toBe(false);
  });

  it('logs a network failure without the token or the visitor email', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': () => { throw new TypeError(`fetch failed for ${TOKEN}`); },
    });
    const { ip, email } = uniq();
    const res = await send(booking({ email }), ip);

    expect(res.status).toBe(201);
    const [row] = await rowsFor(email);
    expect(events()).toContainEqual({ event: 'hubspot.failed', id: row.id, step: 'contact', status: null, error: 'TypeError' });
    const logged = logs.mock.calls.flat().join('\n');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(email);
  });

  it('does not copy a duplicate submission twice', async () => {
    hubspot({
      'PATCH /crm/v3/objects/contacts/': json(200, { id: '61' }),
      'GET /crm/v3/pipelines/deals': json(200, PIPELINES),
      'POST /crm/v3/objects/deals': json(201, { id: '907' }),
    });
    const { ip, email } = uniq();
    await send(booking({ email }), ip);
    await send(booking({ email }), ip);

    expect(await rowsFor(email)).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/crm/v3/objects/deals')).toHaveLength(1);
  });
});

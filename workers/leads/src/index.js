/* Lead capture for the contact form and demo bookings.
   The contact form still posts to FormSubmit, which emails the team. script.js
   also beacons a copy of each submission to POST /api/lead. The /book page
   posts its bookings here directly (book.js). This Worker stores each one in
   D1 so every lead is kept somewhere we own, then optionally pings Slack and
   copies it into HubSpot as a contact plus a deal (src/hubspot.js). */

import { TYPES, describe, slotProblem } from './booking.js';
import { syncLead } from './hubspot.js';

const ENDPOINT = '/api/lead';
// Room for a long message in any script (3 bytes per character in UTF-8).
const MAX_BODY_BYTES = 64 * 1024;
const DUPLICATE_WINDOW = '-10 minutes';
const INSERT_ATTEMPTS = 3;

// Upper bounds match the maxlength attributes on contact.html and book.html.
// The message has no maxlength on contact.html, so the email path keeps any
// length; the body cap bounds it.
const FIELDS = {
  name: { max: 200, required: true },
  email: { max: 254, required: true },
  venue: { max: 200 },
  interest: { max: 100 },
  phone: { max: 40 },
  address: { max: 300 },
  message: {},
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits with the usual separators: +27 64 514 7001, (064) 514-7001.
const PHONE = /^\+?[\d\s().-]+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== ENDPOINT) return reply(404, { error: 'not_found' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });

    const origin = request.headers.get('Origin');
    if (!allowedOrigins(env).includes(origin)) return reply(403, { error: 'forbidden_origin' });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LEAD_LIMITER.limit({ key: ip });
    if (!success) return reply(429, { error: 'rate_limited' });

    const form = await readForm(request);
    if (form === null) return reply(413, { error: 'too_large' });
    if (form === undefined) return reply(400, { error: 'unreadable_body' });

    // Honeypot: people never see this field, so anything in it is a bot.
    // Answer as if it worked so the bot learns nothing.
    if (text(form, '_honey')) {
      log('lead.honeypot', { country: country(request) });
      return reply(204);
    }

    const lead = {};
    for (const [field, rule] of Object.entries(FIELDS)) {
      const value = text(form, field);
      if (rule.required && !value) return reply(400, { error: 'missing_field', field });
      if (rule.max && value.length > rule.max) return reply(400, { error: 'field_too_long', field });
      lead[field] = value || null;
    }
    if (!EMAIL.test(lead.email)) return reply(400, { error: 'invalid_email', field: 'email' });
    if (lead.phone && !validPhone(lead.phone)) return reply(400, { error: 'invalid_phone', field: 'phone' });

    // A booking from /book carries a type and a slot. Anything else is a
    // contact-form lead and keeps the old behaviour.
    const type = text(form, 'type');
    const slot = text(form, 'slot');
    const booking = Boolean(type || slot);
    if (booking) {
      const problem = bookingProblem(type, slot, lead);
      if (problem) return reply(400, problem);
      if (type !== 'onsite') lead.address = null;
    } else {
      lead.address = null;
    }
    lead.booking_type = booking ? type : null;
    lead.booking_slot = booking ? slot : null;

    lead.source = sourcePage(request, origin);
    lead.country = country(request);

    let result;
    try {
      result = await insertLead(env.DB, lead);
    } catch (err) {
      log('lead.store_failed', { error: err && err.name, country: lead.country });
      return reply(503, { error: 'store_failed' });
    }

    const stored = result.meta.changes === 1;
    if (stored) log('lead.stored', { id: result.meta.last_row_id, country: lead.country });
    else log('lead.duplicate', { country: lead.country });

    if (stored && env.SLACK_WEBHOOK_URL) {
      ctx.waitUntil(notifySlack(env.SLACK_WEBHOOK_URL, lead));
    }
    // After the answer, never in its way: HubSpot trouble is logged, not shown.
    if (stored) ctx.waitUntil(syncLead(env, lead, result.meta.last_row_id));
    // Bookings get a body, so book.js can tell this Worker apart from an older
    // one that would drop the slot and answer 204.
    if (booking) return reply(201, { ok: true, booking: { type: lead.booking_type, slot: lead.booking_slot } });
    return reply(204);
  },
};

// Returns a 400 body when a booking cannot be taken, or null.
function bookingProblem(type, slot, lead) {
  if (!type) return { error: 'missing_field', field: 'type' };
  if (!TYPES[type]) return { error: 'invalid_type', field: 'type' };
  if (!slot) return { error: 'missing_field', field: 'slot' };
  const reason = slotProblem(type, slot, Date.now());
  if (reason) return { error: 'invalid_slot', field: 'slot', reason };
  // We confirm bookings on WhatsApp or by phone, and need to know where to go.
  if (!lead.venue) return { error: 'missing_field', field: 'venue' };
  if (!lead.phone) return { error: 'missing_field', field: 'phone' };
  if (type === 'onsite' && !lead.address) return { error: 'missing_field', field: 'address' };
  return null;
}

function validPhone(value) {
  const digits = value.replace(/\D/g, '').length;
  return PHONE.test(value) && digits >= 9 && digits <= 15;
}

// Double clicks and resubmits within the window are stored once. That guard
// also makes a retry safe if a failed attempt had in fact been written. A
// booking for a different slot is a different request, so the slot is part of
// the match (IS compares NULLs as equal, so contact leads match as before).
async function insertLead(db, lead) {
  const statement = db.prepare(
    `INSERT INTO leads (name, email, venue, interest, message, source, country,
                        phone, booking_type, booking_slot, address)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?10, ?11, ?12
     WHERE NOT EXISTS (
       SELECT 1 FROM leads
       WHERE email = ?2 AND message IS ?5
         AND booking_type IS ?10 AND booking_slot IS ?11
         AND created_at > datetime('now', ?8)
     )`
  ).bind(lead.name, lead.email, lead.venue, lead.interest, lead.message,
         lead.source, lead.country, DUPLICATE_WINDOW,
         lead.phone, lead.booking_type, lead.booking_slot, lead.address);

  for (let attempt = 1; ; attempt++) {
    try {
      return await statement.run();
    } catch (err) {
      if (attempt >= INSERT_ATTEMPTS || !retryable(err)) throw err;
      log('lead.store_retry', { attempt, error: err && err.name });
      // Exponential backoff with jitter, as D1's retry guidance recommends.
      await sleep(50 * 2 ** attempt + Math.random() * 50);
    }
  }
}

// D1 retries read-only queries itself, but not writes. These are the
// transient errors its docs list as safe to retry.
function retryable(err) {
  const message = String(err);
  return message.includes('Network connection lost') ||
    message.includes('storage caused object to be reset') ||
    message.includes('reset because its code was updated');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
}

// Reads a form body without buffering more than MAX_BODY_BYTES.
// Returns FormData, null when the body is too large, or undefined when it
// cannot be parsed as a form.
async function readForm(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const type = request.headers.get('Content-Type') || '';
    return await new Response(body, { headers: { 'Content-Type': type } }).formData();
  } catch {
    return undefined;
  }
}

// Form encoding sends line breaks as CRLF. Store LF, as the visitor typed it.
function text(form, name) {
  const value = form.get(name);
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

// The page the form was on, from the Referer, only when it is our own site.
function sourcePage(request, origin) {
  try {
    const referer = new URL(request.headers.get('Referer'));
    return referer.origin === origin ? referer.pathname.slice(0, 200) : null;
  } catch {
    return null;
  }
}

function country(request) {
  return (request.cf && request.cf.country) || null;
}

async function notifySlack(webhook, lead) {
  const lines = lead.booking_slot ? [
    `*New demo booking* from ${slack(lead.name)} (${slack(lead.email)})`,
    `*${slack(describe(lead.booking_type, lead.booking_slot))}*`,
    [lead.venue, lead.phone].filter(Boolean).map(slack).join(' | '),
    lead.address ? 'Address: ' + slack(lead.address).replace(/\n/g, ', ') : '',
    lead.message ? '> ' + slack(lead.message.slice(0, 500)).replace(/\n/g, '\n> ') : '',
  ] : [
    `*New demo request* from ${slack(lead.name)} (${slack(lead.email)})`,
    [lead.venue, lead.interest, lead.phone].filter(Boolean).map(slack).join(' | '),
    lead.message ? '> ' + slack(lead.message.slice(0, 500)).replace(/\n/g, '\n> ') : '',
  ];
  const text = lines.filter(Boolean);

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.join('\n') }),
    });
    if (!res.ok) log('slack.failed', { status: res.status });
  } catch (err) {
    // Only the error name: the message can contain the webhook URL, a secret.
    log('slack.failed', { error: err && err.name });
  }
}

// Slack treats <...> as links and mentions, so escape the three control
// characters to stop a visitor from pinging @channel or faking a link.
function slack(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function reply(status, body, headers = {}) {
  if (status === 204) return new Response(null, { status, headers });
  return Response.json(body, { status, headers });
}

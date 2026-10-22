/* Copies each stored lead into HubSpot as a contact plus a deal.

   Runs after the lead is safe in D1 and after the visitor has their answer
   (ctx.waitUntil), so HubSpot being down, slow or not set up never blocks the
   form. Every outcome is logged with the D1 row id only: no names, emails or
   tokens in the logs.

   Needs the Worker secret HUBSPOT_TOKEN (a HubSpot private app token). See
   README.md for the scopes. CRM v3 REST:
   - contact: PATCH /crm/v3/objects/contacts/{email}?idProperty=email updates an
     existing contact; on 404 we POST a new one, so a repeat visitor is updated,
     never duplicated
   - stage:   GET /crm/v3/pipelines/deals, first stage of the default pipeline
     (cached per isolate), unless HUBSPOT_DEAL_STAGE is set
   - deal:    POST /crm/v3/objects/deals, associated with the contact */

import { describe } from './booking.js';

const API = 'https://api.hubapi.com';
// waitUntil work must finish within 30 seconds of the response.
const CALL_TIMEOUT_MS = 6000;
// HubSpot-defined association type: deal to contact.
const DEAL_TO_CONTACT = 3;
const DEAL_KIND = { online: 'demo', onsite: 'call-out' };

let stageCache = null;

// For tests: forget the pipeline stage looked up earlier in this isolate.
export function resetHubSpotCache() {
  stageCache = null;
}

class HubSpotError extends Error {
  constructor(step, status) {
    super(`HubSpot ${step} failed`);
    this.name = 'HubSpotError';
    this.step = step;
    this.status = status;
  }
}

export async function syncLead(env, lead, id) {
  if (!env.HUBSPOT_TOKEN) {
    log('hubspot.skipped', { id, reason: 'no_token' });
    return;
  }
  const api = client(env.HUBSPOT_TOKEN);
  let step = 'contact';
  try {
    const contactId = await upsertContact(api, lead);
    step = 'pipeline';
    const { pipeline, stage } = await firstStage(api, env);
    step = 'deal';
    const deal = await api('POST', '/crm/v3/objects/deals', {
      properties: {
        dealname: dealName(lead),
        pipeline,
        dealstage: stage,
        description: dealDescription(lead, id),
      },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }],
      }],
    });
    if (!deal.ok || !deal.body || !deal.body.id) throw new HubSpotError('deal', deal.status);
    log('hubspot.synced', { id, contact: String(contactId), deal: String(deal.body.id) });
  } catch (err) {
    // A network error or timeout has no status. Only the name: a message could
    // carry the visitor's email back from HubSpot.
    log('hubspot.failed', {
      id,
      step: err instanceof HubSpotError ? err.step : step,
      status: err instanceof HubSpotError ? err.status : null,
      error: err && err.name,
    });
  }
}

function client(token) {
  return async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  };
}

async function upsertContact(api, lead) {
  const properties = contactProperties(lead);
  const byEmail = `/crm/v3/objects/contacts/${encodeURIComponent(lead.email)}?idProperty=email`;
  let res = await api('PATCH', byEmail, { properties });
  if (res.status === 404) {
    res = await api('POST', '/crm/v3/objects/contacts', { properties });
    // Someone created the same contact a moment ago: update that one instead.
    if (res.status === 409) res = await api('PATCH', byEmail, { properties });
  }
  if (!res.ok || !res.body || !res.body.id) throw new HubSpotError('contact', res.status);
  return res.body.id;
}

// Only what the visitor gave us, so an update never blanks a field in HubSpot.
function contactProperties(lead) {
  const [firstname, ...rest] = lead.name.split(/\s+/);
  const properties = { email: lead.email, firstname, lastname: rest.join(' ') };
  if (lead.phone) properties.phone = lead.phone;
  if (lead.venue) properties.company = lead.venue;
  for (const key of Object.keys(properties)) if (!properties[key]) delete properties[key];
  return properties;
}

async function firstStage(api, env) {
  if (env.HUBSPOT_DEAL_STAGE) {
    return { pipeline: env.HUBSPOT_PIPELINE || 'default', stage: env.HUBSPOT_DEAL_STAGE };
  }
  if (stageCache) return stageCache;

  const res = await api('GET', '/crm/v3/pipelines/deals');
  const pipelines = (res.ok && res.body && Array.isArray(res.body.results)) ? res.body.results : [];
  const live = pipelines.filter((p) => !p.archived);
  const pipeline = live.find((p) => p.id === (env.HUBSPOT_PIPELINE || 'default')) || live.sort(byOrder)[0];
  let stages = pipeline && pipeline.stages;
  if (pipeline && !Array.isArray(stages)) {
    const more = await api('GET', `/crm/v3/pipelines/deals/${encodeURIComponent(pipeline.id)}/stages`);
    stages = more.ok && more.body ? more.body.results : null;
  }
  const stage = Array.isArray(stages) ? stages.filter((s) => !s.archived).sort(byOrder)[0] : null;
  if (!stage) throw new HubSpotError('pipeline', res.status);

  stageCache = { pipeline: pipeline.id, stage: stage.id };
  return stageCache;
}

function byOrder(a, b) {
  return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
}

// "The Engine Room · demo", "The Engine Room · call-out", or "· enquiry" for
// the contact form.
function dealName(lead) {
  const who = lead.venue || lead.name;
  return `${who} · ${DEAL_KIND[lead.booking_type] || 'enquiry'}`;
}

function dealDescription(lead, id) {
  const lines = [];
  if (lead.booking_slot) {
    lines.push(describe(lead.booking_type, lead.booking_slot));
    lines.push(`Type: ${lead.booking_type}`);
    lines.push(`Slot: ${lead.booking_slot}`);
    if (lead.address) lines.push(`Address: ${lead.address.replace(/\n/g, ', ')}`);
    lines.push('Not confirmed yet: confirm the slot with them on WhatsApp or email within one business day.');
  } else if (lead.interest) {
    lines.push(`Interested in: ${lead.interest}`);
  }
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.message) lines.push(`Notes: ${lead.message.slice(0, 2000)}`);
  lines.push(`From ${lead.source || 'the website'} (lead ${id} in D1).`);
  return lines.join('\n');
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

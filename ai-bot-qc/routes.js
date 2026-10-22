const express = require('express');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');
const {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { requireRole, listUsers, isRecordingOnly } = require('../auth');
const { db, upsertCall, addEvent } = require('./db');
const { createBusinessHours } = require('./business-time');

const router = express.Router();
const QC_ADMIN_ROLES = ['super_admin', 'ai_bot_qc_admin'];
const QC_ROLES = [...QC_ADMIN_ROLES, 'ai_bot_qc'];
const CALL_TAGS = ['bot_hangup', 'sales_spam', 'very_satisfied', 'no_interaction', 'greeting_only', 'intent_misunderstood', 'handoff_needed', 'incorrect_information'];
const ENDPOINT = process.env.IDRIVE_E2_ENDPOINT || 'https://d1v3.va01.idrivee2-54.com';
const REGION = process.env.IDRIVE_E2_REGION || 'us-east-1';
const ARCHIVE_PREFIX = (process.env.IDRIVE_E2_PREFIX || 'recordings-v1-production').replace(/^\/+|\/+$/g, '') + '/';
const HUBSPOT_AIRI_PIPELINE = '933309264';
const HUBSPOT_AIRI_INACTIVE_STAGES = new Set(['1435069747', '1435069749']);
const HUBSPOT_CACHE_MS = 5 * 60_000;
const FORWARDING_TEST_BUSINESS_HOURS = 36;
const BUSINESS_DAY_OPEN_HOUR = 9;
const BUSINESS_DAY_CLOSE_HOUR = 17;
const BUSINESS_TIMEZONE = (() => {
  const value = process.env.AI_BOT_QC_BUSINESS_TIMEZONE || 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    console.warn(`[ai-bot-qc] invalid business timezone ${value}; using America/New_York`);
    return 'America/New_York';
  }
})();
const businessHours = createBusinessHours(BUSINESS_TIMEZONE, BUSINESS_DAY_OPEN_HOUR, BUSINESS_DAY_CLOSE_HOUR, FORWARDING_TEST_BUSINESS_HOURS);
const CLAIM_MINUTES = 2;
const IS_INTERNAL_TEST_SQL = 'EXISTS (SELECT 1 FROM bot_qc_excluded_phone_numbers excluded WHERE excluded.phone_number = c.caller_phone)';
const NOT_INTERNAL_TEST_SQL = 'NOT EXISTS (SELECT 1 FROM bot_qc_excluded_phone_numbers excluded WHERE excluded.phone_number = c.caller_phone)';
let client;
let bucketCache = { expires: 0, buckets: [] };
let hubspotAiriCache = { expires: 0, records: new Map() };

function storageConfig() {
  return {
    bucket: process.env.IDRIVE_E2_BUCKET,
    accessKeyId: process.env.IDRIVE_E2_ACCESS_KEY_ID,
    secretAccessKey: process.env.IDRIVE_E2_SECRET_ACCESS_KEY,
  };
}

function getClient() {
  const config = storageConfig();
  if (!config.accessKeyId || !config.secretAccessKey) return null;
  if (!client) {
    client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return client;
}

function safeSegment(value) {
  if (typeof value !== 'string') return null;
  const segment = value.trim();
  if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment) || segment.length > 180) return null;
  return segment;
}

function normalizePhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function callerPhoneFromRoomName(roomName) {
  const match = String(roomName || '').match(/^call-_([+0-9(). -]{7,})_([A-Za-z0-9]+)$/i);
  return normalizePhoneNumber(match?.[1]) || null;
}

function phoneFromMetadata(metadata, direction) {
  const fromKeys = /^(caller(phone|number|id)?|ani|from(number|phone)?|source(number|phone)?|participantidentity)$/;
  const toKeys = /^(to(number|phone)?|destination(number|phone)?|dialed(number|phone)?|called(number|phone)?|target(number|phone)?|recipient(number|phone)?)$/;
  const visit = (value, inheritedDirection = '') => {
    if (!value || typeof value !== 'object') return '';
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const childDirection = fromKeys.test(normalizedKey) ? 'from' : toKeys.test(normalizedKey) ? 'to' : inheritedDirection;
      const directionalKey = direction === 'from' ? fromKeys.test(normalizedKey) : toKeys.test(normalizedKey);
      const nestedPhone = /^(phone|phonenumber|number)$/.test(normalizedKey) && childDirection === direction;
      if ((directionalKey || nestedPhone) && typeof child === 'string') {
        const phone = normalizePhoneNumber(child);
        if (phone) return phone;
      }
      const nested = visit(child, childDirection);
      if (nested) return nested;
    }
    return '';
  };
  if (direction === 'from') {
    const fromPhone = visit(metadata);
    if (fromPhone) return fromPhone;
    const genericPhone = metadata?.phone_number || metadata?.phoneNumber || metadata?.phone;
    return normalizePhoneNumber(genericPhone) || callerPhoneFromRoomName(metadata?.room_name);
  }
  return visit(metadata) || null;
}

const backfillCallerPhonesFromRoomNames = db.transaction(() => {
  const calls = db.prepare(`SELECT id, room_name FROM bot_calls
    WHERE caller_phone IS NULL AND room_name IS NOT NULL`).all();
  const update = db.prepare(`UPDATE bot_calls SET caller_phone = ?,
    caller_phone_checked_at = COALESCE(caller_phone_checked_at, ?)
    WHERE id = ? AND caller_phone IS NULL`);
  const checkedAt = new Date().toISOString();
  let updated = 0;
  for (const call of calls) {
    const phone = callerPhoneFromRoomName(call.room_name);
    if (phone) updated += update.run(phone, checkedAt, call.id).changes;
  }
  return updated;
})();
if (backfillCallerPhonesFromRoomNames) {
  console.log(`[ai-bot-qc] recovered ${backfillCallerPhonesFromRoomNames} caller number(s) from recording room names`);
}

function hubspotNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b(llc|inc|pc|pllc|law|law firm|law office|attorneys|attorney|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hubspotRecordForCustomer(customer, records) {
  const customerKey = hubspotNameKey(customer.replace(/_/g, ' '));
  const exact = records.get(customerKey);
  if (exact) return exact;
  const customerTokens = new Set(customerKey.split(' ').filter(Boolean));
  const matches = new Map();
  for (const [recordKey, record] of records) {
    const tokens = recordKey.split(' ').filter(Boolean);
    if (tokens.length < 2 || !tokens.every(token => customerTokens.has(token))) continue;
    matches.set(record.dealId, record);
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

async function hubspotAiriRecords() {
  if (hubspotAiriCache.expires > Date.now()) return hubspotAiriCache.records;
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === 'production') throw new Error('HubSpot AIRI status lookup is not configured');
    return hubspotAiriCache.records;
  }

  const records = new Map();
  let after;
  do {
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: HUBSPOT_AIRI_PIPELINE }] }],
      limit: 100,
      properties: ['dealname', 'company_name', 'account_name', 'dealstage', 'phone_number', 'phone___s__forwarding_to_service', 'main_business_phone', 'voip_or_provider', 'hs_lastmodifieddate'],
      ...(after ? { after } : {}),
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    for (const deal of response.data.results || []) {
      const properties = deal.properties || {};
      const record = {
        dealId: String(deal.id),
        displayName: properties.account_name || properties.company_name || properties.dealname || '',
        inactive: HUBSPOT_AIRI_INACTIVE_STAGES.has(String(properties.dealstage || '')),
        forwardingNumber: properties.phone___s__forwarding_to_service || '',
        mainBusinessPhone: properties.main_business_phone || '',
        phoneProvider: properties.voip_or_provider || '',
        modifiedAt: properties.hs_lastmodifieddate || deal.updatedAt || '',
      };
      for (const value of [properties.company_name, properties.account_name, deal.properties?.dealname]) {
        const key = hubspotNameKey(value);
        if (!key) continue;
        const existing = records.get(key);
        if (!existing || String(record.modifiedAt).localeCompare(String(existing.modifiedAt)) >= 0) records.set(key, record);
      }
    }
    after = response.data.paging?.next?.after;
  } while (after);

  hubspotAiriCache = { expires: Date.now() + HUBSPOT_CACHE_MS, records };
  return records;
}

async function hubspotAiriMatch(customer) {
  const records = await hubspotAiriRecords();
  return hubspotRecordForCustomer(customer, records);
}

db.exec('CREATE TABLE IF NOT EXISTS bot_customer_names (customer TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, resolved_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
const UUID_CUSTOMER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function greetingToName(greeting) {
  return String(greeting || '')
    .replace(/^(good (morning|afternoon|evening)|hello|hi)[\s,.!…]*/i, '')
    .replace(/^(thank you for calling|thanks for calling|you have reached|welcome to)\s+(the\s+)?/i, '')
    .replace(/[\s,.!…]*(how (may|can) (i|we) (help|assist)).*$/i, '')
    .replace(/^[\s.…]+|[\s.…]+$/g, '')
    .trim();
}

function plainKey(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function firstGreeting(bucket, customer) {
  const calls = db.prepare('SELECT object_key FROM bot_calls WHERE customer = ? ORDER BY call_date DESC, discovered_at DESC LIMIT 6').all(customer);
  for (const { object_key: key } of calls) {
    try {
      const transcript = JSON.parse(await readObjectText(bucket, key));
      const greeting = Array.isArray(transcript) ? transcript.find(message => message?.role === 'assistant' && message.content)?.content : '';
      if (greeting) return String(greeting);
    } catch { /* try the next call */ }
  }
  return '';
}

async function resolveCustomerNames(bucket) {
  const known = new Set(db.prepare('SELECT customer FROM bot_customer_names').all().map(row => row.customer));
  const pending = db.prepare('SELECT DISTINCT customer FROM bot_calls').all().map(row => row.customer).filter(customer => UUID_CUSTOMER.test(customer) && !known.has(customer));
  if (!pending.length) return;
  let records = new Map();
  try { records = await hubspotAiriRecords(); } catch (error) { console.error('[ai-bot-qc] HubSpot name lookup unavailable:', error.message); }
  const insert = db.prepare('INSERT OR REPLACE INTO bot_customer_names (customer, name, source) VALUES (?, ?, ?)');
  for (const customer of pending) {
    const greeting = await firstGreeting(bucket, customer);
    if (!greeting) continue;
    const greetingKey = ` ${plainKey(greeting)} `;
    let best = null;
    for (const record of records.values()) {
      const nameKey = plainKey(record.displayName);
      if (nameKey.length >= 4 && greetingKey.includes(` ${nameKey} `) && (!best || nameKey.length > plainKey(best.displayName).length)) best = record;
    }
    const parsed = greetingToName(greeting);
    if (best?.displayName) insert.run(customer, best.displayName, 'hubspot');
    else if (parsed) insert.run(customer, parsed, 'greeting');
  }
}

// ─── Slack notifications ─────────────────────────────────────────────────────
// Needs SLACK_AIRI_QC_URL (incoming webhook). Optional SLACK_HITSQUAD_GROUP_ID /
// SLACK_QA_AGENTS_GROUP_ID (Slack user group IDs, e.g. S0123ABC) make the mentions actually ping.
db.exec('CREATE TABLE IF NOT EXISTS bot_slack_notices (kind TEXT NOT NULL, ref TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime(\'now\')), PRIMARY KEY (kind, ref))');
const APP_URL = (process.env.APP_BASE_URL || 'https://ops.answeringlegal.com').replace(/\/+$/, '');

function slackMention(envName, fallback) {
  const id = process.env[envName];
  return id ? `<!subteam^${id}>` : `@${fallback}`;
}

function postSlack(text) {
  const url = process.env.SLACK_AIRI_QC_URL;
  if (!url) return;
  axios.post(url, { text, mrkdwn: true }, { timeout: 8000 })
    .catch(error => console.error('[ai-bot-qc] Slack post failed:', error.message));
}

// Claims (kind, ref) so each event is announced once; returns false if already sent.
function claimNotice(kind, ref) {
  return db.prepare('INSERT OR IGNORE INTO bot_slack_notices (kind, ref) VALUES (?, ?)').run(kind, ref).changes > 0;
}

function accountNameFor(customer) {
  return hubspotRecordForCustomer(customer, hubspotAiriCache.records)?.displayName
    || db.prepare('SELECT name FROM bot_customer_names WHERE customer = ?').get(customer)?.name
    || String(customer).replace(/_+/g, ' ').trim();
}

function formatEt(value) {
  return value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : 'unknown';
}

function notifyCallFlag(callId, reviewerOverride) {
  const call = db.prepare(`SELECT c.id, c.customer, r.critical, r.critical_note, r.outcome, r.feedback, r.reviewer_name
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id WHERE c.id = ?`).get(callId);
  if (!call) return;
  const link = `${APP_URL}/?call=${call.id}`;
  const account = accountNameFor(call.customer);
  const reviewer = reviewerOverride || call.reviewer_name || 'A QA Agent';
  const notes = String(call.feedback || '').trim() || 'None';
  if (call.critical && String(call.critical_note || '').trim()) {
    if (!claimNotice('critical', call.id)) return;
    postSlack(`${slackMention('SLACK_HITSQUAD_GROUP_ID', 'hitsquad')} ${reviewer} has flagged a call from ${account} as "Critical Flags" please look into ASAP. Here is the link to the call ${link}. Reviewer Notes: ${notes}. Critical Issue Details: ${call.critical_note.trim()}`);
  } else if (!call.critical && call.outcome === 'needs_follow_up') {
    if (!claimNotice('follow_up', call.id)) return;
    postSlack(`${slackMention('SLACK_HITSQUAD_GROUP_ID', 'hitsquad')} ${reviewer} has flagged a call from ${account} as "Needs Follow Up" please look into ASAP. Here is the link to the call ${link}. Reviewer Notes: ${notes}.`);
  }
}

async function notifyDueForwardingChecks() {
  if (!process.env.SLACK_AIRI_QC_URL) return;
  const { checks } = await forwardingQueue();
  // The first run only records what is already due so deploying doesn't flood the channel.
  const firstRun = claimNotice('forwarding_seed', 'initialized');
  for (const check of checks) {
    if (!claimNotice('forwarding_due', `${check.customer}|${check.last_call_id}`) || firstRun) continue;
    const account = check.hubspot_account_name || accountNameFor(check.customer);
    postSlack(`${slackMention('SLACK_QA_AGENTS_GROUP_ID', 'QAAgents')} ${account} needs to have their forwarding checked. Please test their forwarding number ASAP! Forwarding Number: ${check.forwarding_number || 'not on file'}. Date of last call: ${formatEt(check.last_call_at)}. Once forwarding check is completed please update their forwarding status to: PASS or FAIL`);
  }
}

// Live, never-static list of accounts that can be tested: every active AIRI HubSpot account that has recordings.
// The DID is the number the bot actually answered on (latest recording); HubSpot's forwarding number is the fallback.
async function listTestAccounts() {
  const records = await hubspotAiriRecords();
  const latest = db.prepare(`SELECT customer, destination_phone, call_date, started_at_ns FROM (
      SELECT c.customer, c.destination_phone, c.call_date, c.started_at_ns,
        ROW_NUMBER() OVER (PARTITION BY c.customer ORDER BY c.started_at_ns DESC, c.id DESC) AS rn
      FROM bot_calls c WHERE ${NOT_INTERNAL_TEST_SQL}
    ) WHERE rn = 1`).all();
  const accounts = [];
  for (const row of latest) {
    const record = hubspotRecordForCustomer(row.customer, records);
    if (!record || record.inactive) continue;
    const did = row.destination_phone || record.forwardingNumber || '';
    accounts.push({
      customer: row.customer,
      name: record.displayName || accountNameFor(row.customer),
      did,
      did_source: row.destination_phone ? 'recording' : (record.forwardingNumber ? 'hubspot' : ''),
      forwarding_number: record.forwardingNumber || '',
      last_call_date: row.call_date || '',
      deal_id: record.dealId || '',
    });
  }
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

async function hubspotInactiveCustomers() {
  const records = await hubspotAiriRecords();
  const customers = db.prepare('SELECT DISTINCT customer FROM bot_calls').all();
  return customers
    .filter(({ customer }) => hubspotRecordForCustomer(customer, records)?.inactive)
    .map(({ customer }) => customer);
}

function latestCallForCustomer(customer) {
  return db.prepare(`SELECT c.id, c.customer, c.started_at_ns FROM bot_calls c
    WHERE c.customer = ? AND c.started_at_ns IS NOT NULL AND ${NOT_INTERNAL_TEST_SQL}
    ORDER BY c.started_at_ns DESC, c.id DESC LIMIT 1`).get(customer);
}

async function forwardingQueue(nowMs = Date.now()) {
  const latestCalls = db.prepare(`SELECT id, customer, started_at_ns FROM (
      SELECT id, customer, started_at_ns,
        ROW_NUMBER() OVER (PARTITION BY customer ORDER BY started_at_ns DESC, id DESC) AS row_number
      FROM bot_calls c WHERE started_at_ns IS NOT NULL AND ${NOT_INTERNAL_TEST_SQL}
    ) WHERE row_number = 1 ORDER BY customer COLLATE NOCASE`).all();
  const completedKeys = new Set(db.prepare('SELECT customer, last_call_id FROM bot_forwarding_checks').all()
    .map(row => `${row.customer}\0${row.last_call_id}`));
  const checks = [];
  for (const call of latestCalls) {
    if (completedKeys.has(`${call.customer}\0${call.id}`)) continue;
    const lastCallMs = call.started_at_ns / 1e6;
    const elapsedSeconds = businessHours.secondsBetween(lastCallMs, nowMs);
    if (elapsedSeconds < FORWARDING_TEST_BUSINESS_HOURS * 3600) continue;
    checks.push({
      customer: call.customer,
      last_call_id: call.id,
      last_call_at: new Date(lastCallMs).toISOString(),
      business_hours_elapsed: Math.floor(elapsedSeconds / 3600),
    });
  }
  const completed = db.prepare(`SELECT f.id, f.customer, f.last_call_id, f.checked_by_email, f.checked_by_name, f.checked_at, f.notes, f.result,
      c.started_at_ns AS last_call_started_at
    FROM bot_forwarding_checks f JOIN bot_calls c ON c.id = f.last_call_id
    WHERE f.checked_at >= datetime('now', '-30 days') AND ${NOT_INTERNAL_TEST_SQL}
    ORDER BY f.checked_at DESC LIMIT 200`).all()
    .map(row => ({ ...row, last_call_at: row.last_call_started_at ? new Date(row.last_call_started_at / 1e6).toISOString() : null }));
  const hubspotRecords = await hubspotAiriRecords();
  const inactiveCustomers = new Set();
  const hubspotDetails = new Map();
  for (const call of latestCalls) {
    const record = hubspotRecordForCustomer(call.customer, hubspotRecords);
    if (record) hubspotDetails.set(call.customer, record);
    if (record?.inactive) inactiveCustomers.add(call.customer);
  }
  const activeChecks = checks.filter(check => !inactiveCustomers.has(check.customer) && hubspotDetails.has(check.customer)).map(check => {
    const record = hubspotDetails.get(check.customer);
    return {
      ...check,
      hubspot_account_name: record.displayName,
      forwarding_number: record?.forwardingNumber || '',
      main_business_phone: record?.mainBusinessPhone || '',
      phone_provider: record?.phoneProvider || '',
      hubspot_deal_id: record?.dealId || '',
    };
  });
  const visibleCompleted = completed.filter(check => {
    const record = hubspotRecordForCustomer(check.customer, hubspotRecords);
    return record && !record.inactive;
  }).map(check => {
    const record = hubspotRecordForCustomer(check.customer, hubspotRecords);
    return {
      ...check,
      hubspot_account_name: record.displayName,
      hubspot_deal_id: record.dealId || '',
    };
  });
  return {
    checks: activeChecks,
    completed: visibleCompleted,
    completed_window_days: 30,
    threshold_business_hours: FORWARDING_TEST_BUSINESS_HOURS,
    business_calendar: `Monday-Friday, 09:00-17:00 ${BUSINESS_TIMEZONE}`,
  };
}

function needStorage(res) {
  if (getClient()) return true;
  res.status(503).json({ error: 'iDrive e2 credentials are not configured', configured: false });
  return false;
}

function storageFailure(res, error, fallback, permission) {
  const denied = error?.Code === 'AccessDenied' || error?.name === 'AccessDenied';
  const bucket = storageConfig().bucket || 'selected bucket';
  console.error('[ai-bot-qc] storage request failed:', error.Code || error.name, error.message);
  res.status(denied ? 403 : 502).json({
    error: denied ? `iDrive denied this request. Grant read-only ${permission} access to ${bucket}.` : fallback,
  });
}

async function discoverBuckets() {
  const { bucket } = storageConfig();
  if (bucket) return [bucket];
  if (bucketCache.expires > Date.now()) return bucketCache.buckets;
  const result = await getClient().send(new ListBucketsCommand({}));
  bucketCache = {
    expires: Date.now() + 60_000,
    buckets: (result.Buckets || []).map(item => item.Name).filter(Boolean).sort(),
  };
  return bucketCache.buckets;
}

async function resolveBucket(req) {
  const configuredBucket = storageConfig().bucket;
  const requestedBucket = safeSegment(req.query.bucket);
  if (configuredBucket) return !requestedBucket || requestedBucket === configuredBucket ? configuredBucket : null;
  if (!requestedBucket) return null;
  const buckets = await discoverBuckets();
  return buckets.includes(requestedBucket) ? requestedBucket : null;
}

async function listAll(bucket, input) {
  const s3 = getClient();
  const entries = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ...input,
      ContinuationToken: continuationToken,
    }));
    entries.push(...(page.Contents || []));
    if (input.Delimiter) entries.push(...(page.CommonPrefixes || []));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return entries;
}

async function readObjectText(bucket, key) {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  let text = '';
  for await (const chunk of result.Body) text += chunk.toString('utf8');
  return text;
}

function actorFor(req) {
  return {
    email: req.user.email || 'dev@local',
    name: req.user.name || req.user.email || 'Unknown reviewer',
  };
}

function callId(bucket, metadataKey) {
  return require('crypto').createHash('sha256').update(`${bucket}:${metadataKey}`).digest('hex');
}

async function indexCall(bucket, customer, date, metadataObject, audioObjects) {
  const metadataKey = metadataObject.Key;
  const metadata = JSON.parse(await readObjectText(bucket, metadataKey));
  const recordingLocations = (Array.isArray(metadata.files) ? metadata.files : [])
    .map(file => String(file?.location || '').split('?')[0]);
  const audioKeys = audioObjects
    .filter(object => recordingLocations.some(location => location.endsWith(object.Key)))
    .map(object => object.Key);
  const key = metadataKey;
  const id = callId(bucket, key);
  upsertCall({
    id,
    bucket,
    object_key: key,
    customer,
    caller_phone: phoneFromMetadata(metadata, 'from'),
    caller_phone_checked_at: new Date().toISOString(),
    destination_phone: phoneFromMetadata(metadata, 'to'),
    destination_phone_checked_at: new Date().toISOString(),
    call_date: date,
    room_name: String(metadata.room_name || ''),
    room_id: String(metadata.room_id || ''),
    egress_id: String(metadata.egress_id || ''),
    started_at_ns: Number.isFinite(Number(metadata.started_at)) ? Math.trunc(Number(metadata.started_at)) : null,
    ended_at_ns: Number.isFinite(Number(metadata.ended_at)) ? Math.trunc(Number(metadata.ended_at)) : null,
    recording_keys: JSON.stringify(audioKeys),
    metadata_key: key,
    metadata_last_modified: metadataObject.LastModified?.toISOString?.() || null,
  });
  return id;
}

async function syncCustomer(bucket, customer) {
  const customerPrefix = `${ARCHIVE_PREFIX}${customer}/`;
  const dateEntries = await listAll(bucket, { Prefix: customerPrefix, Delimiter: '/' });
  const dates = dateEntries.filter(entry => entry.Prefix)
    .map(entry => entry.Prefix.slice(customerPrefix.length, -1));
  let indexed = 0;
  for (const date of dates) {
    const prefix = `${customerPrefix}${date}/`;
    const objects = await listAll(bucket, { Prefix: prefix });
    const audioObjects = objects.filter(object => /\.(ogg|mp3|wav|m4a|opus|webm|aac)$/i.test(object.Key));
    const metadataObjects = objects.filter(object => /\.json$/i.test(object.Key));
    for (const object of metadataObjects) {
      try {
        const existing = db.prepare('SELECT metadata_last_modified, caller_phone_checked_at, destination_phone_checked_at FROM bot_calls WHERE object_key = ?').get(object.Key);
        const modified = object.LastModified?.toISOString?.() || null;
        if (existing && existing.metadata_last_modified === modified && existing.caller_phone_checked_at && existing.destination_phone_checked_at) continue;
        await indexCall(bucket, customer, date, object, audioObjects);
        indexed += 1;
      } catch (error) {
        console.error('[ai-bot-qc] sidecar skipped:', object.Key, error.message);
      }
    }
  }
  return indexed;
}

async function syncArchive(bucket) {
  const objects = await listAll(bucket, { Prefix: ARCHIVE_PREFIX });
  const metadataObjects = objects.filter(object => object.Key && /\.json$/i.test(object.Key));
  const audioByFolder = new Map();
  for (const object of objects) {
    if (!object.Key || !/\.(ogg|mp3|wav|m4a|opus|webm|aac)$/i.test(object.Key)) continue;
    const segments = object.Key.split('/');
    if (segments.length < 4) continue;
    const folder = segments.slice(0, -1).join('/');
    if (!audioByFolder.has(folder)) audioByFolder.set(folder, []);
    audioByFolder.get(folder).push(object);
  }
  let indexed = 0;
  for (const object of metadataObjects) {
    const segments = object.Key.slice(ARCHIVE_PREFIX.length).split('/');
    if (segments.length < 3) continue;
    const [customer, date] = segments;
    if (!safeSegment(customer) || !safeSegment(date)) continue;
    const existing = db.prepare('SELECT metadata_last_modified, caller_phone_checked_at, destination_phone_checked_at FROM bot_calls WHERE object_key = ?').get(object.Key);
    const modified = object.LastModified?.toISOString?.() || null;
    if (existing && existing.metadata_last_modified === modified && existing.caller_phone_checked_at && existing.destination_phone_checked_at) continue;
    try {
      await indexCall(bucket, customer, date, object, audioByFolder.get(`${ARCHIVE_PREFIX}${customer}/${date}`) || []);
      indexed += 1;
    } catch (error) {
      console.error('[ai-bot-qc] sidecar skipped:', object.Key, error.message);
    }
  }
  return { indexed, object_count: objects.length };
}

function callRow(row) {
  return {
    ...row,
    hubspot_account_name: hubspotRecordForCustomer(row.customer, hubspotAiriCache.records)?.displayName || '',
    recording_keys: JSON.parse(row.recording_keys || '[]'),
    call_tags: JSON.parse(row.call_tags || '[]'),
    is_internal_test: Boolean(row.is_internal_test),
    caller_happiness: Number.isInteger(row.caller_happiness) && row.caller_happiness >= 1 && row.caller_happiness <= 5 ? row.caller_happiness : null,
    duration_seconds: row.started_at_ns && row.ended_at_ns
      ? Math.max(0, Math.round((row.ended_at_ns - row.started_at_ns) / 1e9))
      : null,
  };
}

function localDayBounds(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const partsAt = timestamp => Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const current = partsAt(now.getTime());
  const nextDay = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) + 1));
  const toUtc = (year, month, day) => {
    const target = Date.UTC(year, month - 1, day);
    let guess = target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = partsAt(guess);
      const represented = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
      const adjusted = guess + target - represented;
      if (adjusted === guess) break;
      guess = adjusted;
    }
    return new Date(guess).toISOString();
  };
  return {
    start: toUtc(Number(current.year), Number(current.month), Number(current.day)),
    end: toUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate()),
  };
}

function normalizedCallTags(value, fallback = []) {
  const tags = Array.isArray(value) ? value : fallback;
  return [...new Set(tags.filter(tag => CALL_TAGS.includes(tag)))];
}

function normalizedHappiness(value, fallback = null) {
  const rating = value === undefined ? fallback : Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

const FOLLOW_UP_TAGS = ['bot_hangup', 'intent_misunderstood', 'handoff_needed', 'incorrect_information'];

function requireCall(req, res) {
  const row = db.prepare(`SELECT c.*, r.status, r.outcome, r.caller_happiness, r.feedback, r.call_tags, r.critical, r.critical_flagged_at, r.critical_note,
  r.reviewer_email, r.reviewer_name, r.assigned_to_email, r.assigned_to_name, r.assigned_by_email, r.assigned_by_name, r.assigned_at,
  r.claimed_at, r.claim_expires_at, r.last_saved_at,
      r.reviewed_at, r.updated_at, ${IS_INTERNAL_TEST_SQL} AS is_internal_test,
      (SELECT e.label FROM bot_qc_excluded_phone_numbers e WHERE e.phone_number = c.caller_phone) AS internal_test_label
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id WHERE c.id = ?`).get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Call not found. Refresh the QC queue to index this recording.' });
    return null;
  }
  return row;
}

function eventRows(callId) {
  return db.prepare(`SELECT actor_email, actor_name, event_type, details, created_at
    FROM bot_review_events WHERE call_id = ? ORDER BY id DESC`).all(callId)
    .map(event => ({ ...event, details: JSON.parse(event.details || '{}') }));
}

function claimIsActive(row) {
  return row.status === 'in_review' && row.claim_expires_at && row.claim_expires_at > new Date().toISOString();
}

function releaseExpiredClaims() {
  const expired = db.prepare(`SELECT call_id, reviewer_email, reviewer_name FROM bot_reviews
    WHERE status = 'in_review' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`)
    .all(new Date().toISOString());
  const release = db.transaction(() => {
    for (const claim of expired) {
      db.prepare(`UPDATE bot_reviews SET status = 'unreviewed', claim_expires_at = NULL, updated_at = datetime('now')
        WHERE call_id = ? AND status = 'in_review'`).run(claim.call_id);
      addEvent(claim.call_id, { email: 'system@qc', name: 'QC system' }, 'claim_expired', { previous_reviewer: claim.reviewer_name });
    }
  });
  release();
}

function ownsActiveClaim(row, actor, isAdmin) {
  return isAdmin || (claimIsActive(row) && row.reviewer_email === actor.email);
}

function isQcAdmin(req) {
  const userRoles = [req.user?.role, ...(req.user?.additionalRoles || [])];
  return userRoles.some(role => QC_ADMIN_ROLES.includes(role));
}

// AIRI Interns reach only the recording view and its audio stream (no downloads, no review data).
const qcGate = requireRole(...QC_ROLES);
const internGate = requireRole('ai_bot_qc_intern');
router.use((req, res, next) => {
  if (!isRecordingOnly(req.user)) return qcGate(req, res, next);
  const allowed = req.method === 'GET' && (/^\/calls\/[^/]+\/recording$/.test(req.path) || req.path === '/artifact');
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  internGate(req, res, next);
});

// Reject cross-site state-changing requests (CSRF defense in depth beyond sameSite=lax).
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid origin */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
router.use(limiter(60 * 1000, 600));
router.post('/sync', limiter(60 * 1000, 6));
router.post('/bulletin/polish', limiter(60 * 1000, 10));
router.post('/calls/assign', limiter(60 * 1000, 30));
router.use('/outbound-tests', require('./outbound-tests')({ listAccounts: listTestAccounts }));

router.get('/agents', (req, res) => {
  const agents = Object.entries(listUsers()).flatMap(([email, record]) => {
    const roles = [record.role, ...(record.additionalRoles || [])];
    if (!roles.some(role => ['ai_bot_qc', 'ai_bot_qc_admin', 'super_admin'].includes(role))) return [];
    return [{ email: email.toLowerCase(), name: record.name || email }];
  }).sort((left, right) => left.name.localeCompare(right.name));
  res.json({ agents });
});

router.get('/account-names', async (req, res) => {
  try {
    if (getClient()) {
      const bucket = await resolveBucket(req);
      if (bucket) await resolveCustomerNames(bucket);
    }
  } catch (error) {
    console.error('[ai-bot-qc] account name resolution failed:', error.message);
  }
  const names = {};
  for (const row of db.prepare('SELECT customer, name FROM bot_customer_names').all()) names[row.customer] = row.name;
  res.json({ names });
});

router.get('/review-criteria', (req, res) => {
  res.download(path.join(__dirname, '..', 'docs', 'AIRI-QA-REVIEW-CRITERIA.md'), 'AIRI-QA-Review-Criteria.md');
});

router.get('/training-user-guide', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const guidePath = path.join(__dirname, '..', 'docs', 'AIRI-QA-TRAINING-USER-GUIDE.docx');
  res.download(guidePath, 'AIRI-QA-Training-and-User-Guide.docx', error => {
    if (error && !res.headersSent) {
      console.error('[ai-bot-qc] training guide download failed:', error.message);
      res.status(404).json({ error: 'The training guide is not available yet. Ask an administrator to deploy the latest version.' });
    }
  });
});

router.get('/excluded-phone-numbers', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const numbers = db.prepare(`SELECT n.id, n.display_phone, n.label, n.created_by_name, n.created_at,
      (SELECT COUNT(*) FROM bot_calls c WHERE c.caller_phone = n.phone_number) AS call_count
    FROM bot_qc_excluded_phone_numbers n ORDER BY n.created_at DESC, n.id DESC`).all();
  res.json({ numbers });
});

router.post('/excluded-phone-numbers', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const displayPhone = String(req.body?.phone_number || '').trim().slice(0, 40);
  const phoneNumber = normalizePhoneNumber(displayPhone);
  const label = String(req.body?.label || '').trim().slice(0, 80);
  const callId = req.body?.call_id;
  if (!phoneNumber) return res.status(400).json({ error: 'Enter a valid phone number with at least 7 digits.' });
  if (callId !== undefined && (typeof callId !== 'string' || !/^[a-f0-9]{64}$/.test(callId))) {
    return res.status(400).json({ error: 'A valid recording is required when flagging a caller from the review queue.' });
  }
  const actor = actorFor(req);
  try {
    const save = db.transaction(() => {
      if (callId && !db.prepare('SELECT 1 FROM bot_calls WHERE id = ?').get(callId)) return null;
      const inserted = db.prepare(`INSERT INTO bot_qc_excluded_phone_numbers
        (phone_number, display_phone, label, created_by_email, created_by_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO NOTHING`)
        .run(phoneNumber, displayPhone, label, actor.email, actor.name);
      if (callId) {
        const call = db.prepare('SELECT caller_phone FROM bot_calls WHERE id = ?').get(callId);
        if (call.caller_phone !== phoneNumber) {
          db.prepare('UPDATE bot_calls SET caller_phone = ?, caller_phone_checked_at = ? WHERE id = ?')
            .run(phoneNumber, new Date().toISOString(), callId);
          addEvent(callId, actor, 'caller_id_excluded', { phone_number: phoneNumber });
        }
      }
      return Boolean(inserted.changes);
    });
    const inserted = save();
    if (inserted === null) return res.status(404).json({ error: 'Recording not found.' });
    const number = db.prepare(`SELECT n.id, n.display_phone, n.label, n.created_by_name, n.created_at,
        (SELECT COUNT(*) FROM bot_calls c WHERE c.caller_phone = n.phone_number) AS call_count
      FROM bot_qc_excluded_phone_numbers n WHERE n.phone_number = ?`).get(phoneNumber);
    return res.status(inserted ? 201 : 200).json({ number, added: inserted });
  } catch (error) {
    console.error('[ai-bot-qc] excluded caller number save failed:', error.message);
    return res.status(500).json({ error: 'Could not save the excluded caller number.' });
  }
});

router.delete('/excluded-phone-numbers/:id', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'A valid excluded number is required.' });
  const deleted = db.prepare('DELETE FROM bot_qc_excluded_phone_numbers WHERE id = ?').run(id).changes;
  if (!deleted) return res.status(404).json({ error: 'Excluded phone number not found.' });
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  const config = storageConfig();
  res.json({
    configured: Boolean(config.accessKeyId && config.secretAccessKey),
    bucket: config.bucket || '',
    bucketDiscovery: !config.bucket,
    archivePrefix: ARCHIVE_PREFIX,
    endpoint: ENDPOINT,
    region: REGION,
    missing: [
      !config.accessKeyId && 'IDRIVE_E2_ACCESS_KEY_ID',
      !config.secretAccessKey && 'IDRIVE_E2_SECRET_ACCESS_KEY',
    ].filter(Boolean),
  });
});

router.get('/bulletin', (req, res) => {
  const now = new Date();
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const total = db.prepare('SELECT COUNT(*) AS total FROM bot_qc_bulletin_posts WHERE deleted_at IS NULL').get().total;
  const posts = db.prepare(`SELECT id, body, notice_type, expires_on, created_by_name, created_at
    FROM bot_qc_bulletin_posts WHERE deleted_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset).map(post => {
      const createdAt = Date.parse(post.created_at);
      const isExpired = Boolean(post.expires_on && post.expires_on < now.toISOString().slice(0, 10));
      return { ...post, is_expired: isExpired, is_recent: Number.isFinite(createdAt) && now.getTime() - createdAt <= 7 * 24 * 60 * 60 * 1000 };
    });
  res.json({ posts, total, limit, offset, bulletin: offset === 0 ? posts[0] || null : null });
});

router.post('/bulletin', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const actor = actorFor(req);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  const noticeType = ['bug', 'watch', 'test'].includes(req.body?.notice_type) ? req.body.notice_type : '';
  const expiresOn = String(req.body?.expires_on || '').trim() || null;
  if (!body) return res.status(400).json({ error: 'Write a team focus post before adding it.' });
  if (!noticeType) return res.status(400).json({ error: 'Choose Bug, Watch, or Test for the notice' });
  if (expiresOn) {
    const expiresAt = Date.parse(`${expiresOn}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || !Number.isFinite(expiresAt)
      || new Date(expiresAt).toISOString().slice(0, 10) !== expiresOn
      || expiresOn < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Expiry must be today or a future date' });
    }
  }
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const inserted = db.prepare(`INSERT INTO bot_qc_bulletin_posts
      (body, notice_type, expires_on, created_by_email, created_by_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(body, noticeType, expiresOn, actor.email, actor.name, now);
    db.prepare(`INSERT INTO bot_qc_bulletin_history (body, notice_type, expires_on, updated_by_email, updated_by_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(body, noticeType, expiresOn, actor.email, actor.name, now);
    return db.prepare(`SELECT id, body, notice_type, expires_on, created_by_name, created_at
      FROM bot_qc_bulletin_posts WHERE id = ?`).get(inserted.lastInsertRowid);
  });
  const post = result();
  res.status(201).json({ ok: true, post: { ...post, is_expired: false, is_recent: true } });
});

router.delete('/bulletin/:id', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'A valid Team focus post is required.' });
  const actor = actorFor(req);
  const deletedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE bot_qc_bulletin_posts SET deleted_at = ?, deleted_by_email = ?, deleted_by_name = ?
    WHERE id = ? AND deleted_at IS NULL`).run(deletedAt, actor.email, actor.name, id);
  if (!result.changes) return res.status(404).json({ error: 'Team focus post not found.' });
  res.json({ ok: true, id, deleted_at: deletedAt });
});

router.post('/bulletin/polish', requireRole(...QC_ADMIN_ROLES), async (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write the team focus text before polishing it' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI text polishing is unavailable: Gemini is not configured on this server' });
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        contents: [{ parts: [{ text: `You edit short internal QA team-focus notices. Preserve every factual claim, test requirement, urgency, and intended meaning. Improve clarity, grammar, and concision. Do not invent bugs, causes, dates, or instructions. Return only the polished notice text, with no preamble or quotation marks.\n\nNotice:\n${body}` }] }],
        generationConfig: { maxOutputTokens: 700, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      },
      { headers: { 'X-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const suggestion = (response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().slice(0, 2000);
    if (!suggestion) throw new Error('The AI returned no text');
    res.json({ suggestion });
  } catch (error) {
    console.error('[ai-bot-qc] bulletin polish failed:', error.response?.status || error.message);
    res.status(502).json({ error: 'Could not polish the team focus text. Your original text is unchanged.' });
  }
});

router.get('/bulletin/history', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const history = db.prepare(`SELECT body, notice_type, expires_on, updated_by_name, updated_at FROM bot_qc_bulletin_history
    ORDER BY id DESC LIMIT 50`).all();
  res.json({ history });
});

router.post('/sync', async (req, res) => {
  if (!needStorage(res)) return;
  try {
    const bucket = await resolveBucket(req);
    if (!bucket) return res.status(400).json({ error: 'Choose a valid bucket first' });
    const result = await syncArchive(bucket);
    res.json({ ok: true, ...result });
  } catch (error) {
    storageFailure(res, error, 'Could not sync recordings from iDrive e2', 's3:ListBucket and s3:GetObject');
  }
});

router.get('/queue', async (req, res) => {
  releaseExpiredClaims();
  const where = [];
  const params = [];
  const status = ['unreviewed', 'in_review', 'reviewed'].includes(req.query.status) ? req.query.status : '';
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (req.query.critical === '1') where.push('r.critical = 1');
  if (req.query.assigned === 'me') { where.push('r.assigned_to_email = ?'); params.push(String(actorFor(req).email).toLowerCase()); }
  if (req.query.customer) { where.push('c.customer = ?'); params.push(safeSegment(req.query.customer)); }
  if (req.query.reviewer_email) { where.push('r.reviewer_email = ?'); params.push(String(req.query.reviewer_email).slice(0, 180)); }
  if (req.query.q) {
    const rawQuery = String(req.query.q).trim().slice(0, 120);
    const query = `%${rawQuery}%`;
    const callerDigits = rawQuery.replace(/\D/g, '');
    const normalizedCallerDigits = callerDigits.length === 11 && callerDigits.startsWith('1') ? callerDigits.slice(1) : callerDigits;
    const callerFilter = normalizedCallerDigits.length >= 3 ? ' OR c.caller_phone LIKE ?' : '';
    where.push(`(c.customer LIKE ? OR c.call_date LIKE ? OR c.room_name LIKE ?${callerFilter} OR r.reviewer_name LIKE ? OR r.reviewer_email LIKE ?)`);
    params.push(query, query, query, ...(callerFilter ? [`%${normalizedCallerDigits}%`] : []), query, query);
  }
  const internalTests = ['include', 'only'].includes(req.query.internal_tests) ? req.query.internal_tests : 'hide';
  if (internalTests === 'hide') where.push(NOT_INTERNAL_TEST_SQL);
  else if (internalTests === 'only') where.push(IS_INTERNAL_TEST_SQL);
  try {
    const inactiveCustomers = await hubspotInactiveCustomers();
    if (inactiveCustomers.length) {
      where.push(`c.customer NOT IN (${inactiveCustomers.map(() => '?').join(',')})`);
      params.push(...inactiveCustomers);
    }
  } catch (error) {
    console.error('[ai-bot-qc] HubSpot AIRI status lookup failed:', error.response?.status || error.message);
    return res.status(503).json({ error: 'Could not verify AIRI account status in HubSpot. Refresh the queue shortly.' });
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id ${whereSql}`).get(...params).total;
  const internalTestTotal = db.prepare(`SELECT COUNT(*) AS n FROM bot_calls c WHERE ${IS_INTERNAL_TEST_SQL}`).get().n;
  const internalTestInResults = internalTests === 'hide' ? 0
    : db.prepare(`SELECT COUNT(*) AS n FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id ${whereSql}${whereSql ? ' AND' : ' WHERE'} ${IS_INTERNAL_TEST_SQL}`).get(...params).n;
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const sortColumns = {
    call_date: 'c.started_at_ns',
    caller_id: 'c.caller_phone COLLATE NOCASE',
    account: 'c.customer COLLATE NOCASE',
    status: `CASE r.status WHEN 'unreviewed' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END`,
    qa_agent: 'r.reviewer_name COLLATE NOCASE',
    duration: `CASE WHEN c.started_at_ns IS NOT NULL AND c.ended_at_ns IS NOT NULL THEN c.ended_at_ns - c.started_at_ns ELSE -1 END`,
  };
  const sortColumn = Object.hasOwn(sortColumns, req.query.sort_by) ? sortColumns[req.query.sort_by] : null;
  const sortDirection = req.query.sort_dir === 'asc' ? 'ASC' : 'DESC';
  const orderSql = sortColumn
    ? `ORDER BY ${sortColumn} ${sortDirection}, c.started_at_ns DESC, c.id DESC`
    : `ORDER BY CASE r.status WHEN 'unreviewed' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,
      r.critical DESC, c.started_at_ns DESC`;
  const rows = db.prepare(`SELECT c.*, r.status, r.outcome, r.caller_happiness, r.feedback, r.call_tags, r.critical, r.critical_note,
      r.reviewer_email, r.reviewer_name, r.assigned_to_email, r.assigned_to_name, r.assigned_by_email, r.assigned_by_name, r.assigned_at,
      r.claimed_at, r.claim_expires_at, r.last_saved_at,
      r.reviewed_at, r.updated_at, ${IS_INTERNAL_TEST_SQL} AS is_internal_test,
      (SELECT e.label FROM bot_qc_excluded_phone_numbers e WHERE e.phone_number = c.caller_phone) AS internal_test_label
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id
    ${whereSql}
    ${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ calls: rows.map(callRow), total, limit, offset, internal_test_total: internalTestTotal, internal_test_in_results: internalTestInResults });
});

const HAPPINESS_LABELS = { 1: 'Very unhappy', 2: 'Unhappy', 3: 'Neutral', 4: 'Happy', 5: 'Very happy' };

// Prefix cells that spreadsheets would treat as formulas, then quote per RFC 4180.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^\+?\d[\d\s().-]*$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

router.get('/export', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const where = [`r.status = 'reviewed'`, NOT_INTERNAL_TEST_SQL];
  const params = [];
  const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  if (dateOk(req.query.from)) { where.push('substr(r.reviewed_at, 1, 10) >= ?'); params.push(req.query.from); }
  if (dateOk(req.query.to)) { where.push('substr(r.reviewed_at, 1, 10) <= ?'); params.push(req.query.to); }
  if (req.query.critical === '1') where.push('r.critical = 1');
  if (req.query.customer) { where.push('c.customer = ?'); params.push(safeSegment(req.query.customer)); }
  if (req.query.reviewer_email) { where.push('r.reviewer_email = ?'); params.push(String(req.query.reviewer_email).slice(0, 180)); }
  const rows = db.prepare(`SELECT c.id, c.customer, c.caller_phone, c.destination_phone, c.call_date, c.started_at_ns, c.ended_at_ns,
      r.outcome, r.caller_happiness, r.feedback, r.call_tags, r.critical, r.critical_note, r.reviewer_name, r.reviewer_email, r.reviewed_at
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY r.reviewed_at DESC LIMIT 20000`).all(...params);

  const tagLabels = {
    bot_hangup: 'Caller hung up, possibly due to the bot', sales_spam: 'Sales, spam, or marketing call', very_satisfied: 'Caller sounded very satisfied',
    no_interaction: 'No meaningful interaction on the call', greeting_only: 'Caller only said a greeting', intent_misunderstood: 'Bot misunderstood the caller’s intent',
    handoff_needed: 'Transfer or escalation was needed', incorrect_information: 'Bot gave incorrect information',
  };
  const header = ['Call ID', 'Account', 'Call date', 'Call start (ET)', 'Duration (sec)', 'Caller phone', 'Destination phone', 'Outcome', 'Caller happiness',
    'Call tags', 'Human feedback', 'Critical', 'Critical issue details', 'Reviewer', 'Reviewer email', 'Reviewed at (ET)', 'Recording link (login required)'];
  const base = (process.env.APP_BASE_URL || 'https://ops.answeringlegal.com').replace(/\/+$/, '');
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    let tags = [];
    try { tags = JSON.parse(row.call_tags || '[]'); } catch { /* keep empty */ }
    const startedMs = row.started_at_ns ? Math.round(row.started_at_ns / 1e6) : null;
    lines.push([
      row.id,
      accountNameFor(row.customer),
      row.call_date,
      startedMs ? formatEt(startedMs) : '',
      row.started_at_ns && row.ended_at_ns ? Math.max(0, Math.round((row.ended_at_ns - row.started_at_ns) / 1e9)) : '',
      row.caller_phone || '',
      row.destination_phone || '',
      row.outcome === 'needs_follow_up' ? 'Needs follow up' : row.outcome === 'ok' ? 'OK' : '',
      HAPPINESS_LABELS[row.caller_happiness] || '',
      tags.map(tag => tagLabels[tag] || tag).join('; '),
      row.feedback,
      row.critical ? 'Yes' : 'No',
      row.critical_note,
      row.reviewer_name || '',
      row.reviewer_email || '',
      row.reviewed_at ? formatEt(row.reviewed_at) : '',
      `${base}/?recording=${encodeURIComponent(row.id)}`,
    ].map(csvCell).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="airi-qa-reviews-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\ufeff${lines.join('\r\n')}\r\n`);
});

router.post('/calls/assign', (req, res) => {
  const actor = actorFor(req);
  const callIds = [...new Set(Array.isArray(req.body?.call_ids) ? req.body.call_ids.filter(id => typeof id === 'string' && id.length <= 180) : [])];
  const assignedEmail = String(req.body?.assigned_to_email || '').trim().toLowerCase();
  if (!callIds.length || callIds.length > 100) return res.status(400).json({ error: 'Select between 1 and 100 calls to assign.' });
  if (!assignedEmail) return res.status(400).json({ error: 'Choose a QA Agent.' });
  if (!isQcAdmin(req) && assignedEmail !== actor.email.toLowerCase()) {
    return res.status(403).json({ error: 'QA Agents can only assign calls to themselves. Ask a manager to assign to someone else.' });
  }

  const target = Object.entries(listUsers()).find(([email]) => email.toLowerCase() === assignedEmail);
  const targetRoles = target ? [target[1].role, ...(target[1].additionalRoles || [])] : [];
  if (!target || !targetRoles.some(role => ['ai_bot_qc', 'ai_bot_qc_admin', 'super_admin'].includes(role))) {
    return res.status(400).json({ error: 'Choose an active AIRI QA Agent.' });
  }
  const now = new Date().toISOString();
  const assign = db.transaction(() => {
    const rows = callIds.map(callId => db.prepare(`SELECT r.call_id, r.status, r.critical, r.reviewer_email, r.reviewer_name, r.claim_expires_at
      FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id WHERE r.call_id = ? AND ${NOT_INTERNAL_TEST_SQL}`).get(callId));
    if (rows.some(row => !row)) return { error: 'One or more selected calls are no longer available.' };
    if (rows.some(row => row.status === 'reviewed' && !row.critical)) return { error: 'Reviewed calls cannot be assigned.' };
    if (rows.some(row => claimIsActive(row) && row.reviewer_email !== assignedEmail)) return { error: 'A selected call is actively being reviewed. Refresh the queue and try again.' };
    const update = db.prepare(`UPDATE bot_reviews SET assigned_to_email = ?, assigned_to_name = ?, assigned_by_email = ?, assigned_by_name = ?, assigned_at = ?, updated_at = ?
      WHERE call_id = ?`);
    for (const row of rows) {
      update.run(assignedEmail, target[1].name || assignedEmail, actor.email, actor.name, now, now, row.call_id);
      addEvent(row.call_id, actor, 'assigned', { assigned_to_email: assignedEmail, assigned_to_name: target[1].name || assignedEmail });
    }
    return { assigned: rows.length };
  });
  const result = assign();
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, ...result });
});

router.get('/forwarding-checks', async (req, res) => {
  try {
    res.json(await forwardingQueue());
  } catch (error) {
    console.error('[ai-bot-qc] HubSpot forwarding status lookup failed:', error.response?.status || error.message);
    res.status(503).json({ error: 'Could not verify AIRI account status in HubSpot. Refresh forwarding checks shortly.' });
  }
});

router.post('/forwarding-checks/:customer/complete', async (req, res) => {
  const customer = safeSegment(req.params.customer);
  const callId = typeof req.body?.last_call_id === 'string' ? req.body.last_call_id : '';
  const notes = String(req.body?.notes || '').trim().slice(0, 1000);
  const result = req.body?.result;
  if (!customer || !/^[a-f0-9]{64}$/.test(callId)) {
    return res.status(400).json({ error: 'A valid account and latest call are required' });
  }
  if (!['reached_airi', 'not_reaching_airi'].includes(result)) {
    return res.status(400).json({ error: 'Choose whether the test reached AIRI before completing it.' });
  }
  let hubspotRecord;
  try {
    hubspotRecord = await hubspotAiriMatch(customer);
    if (!hubspotRecord) {
      return res.status(409).json({ error: 'This account is not matched to an AIRI HubSpot deal and is not eligible for forwarding checks.' });
    }
    if (hubspotRecord.inactive) {
      return res.status(409).json({ error: 'This account is inactive in HubSpot and is no longer eligible for forwarding checks.' });
    }
  } catch (error) {
    console.error('[ai-bot-qc] HubSpot forwarding verification failed:', error.response?.status || error.message);
    return res.status(503).json({ error: 'Could not verify this account status in HubSpot. Try again shortly.' });
  }
  const latest = latestCallForCustomer(customer);
  if (!latest || latest.id !== callId) {
    return res.status(409).json({ error: 'A newer call was received. Refresh the forwarding-check queue before completing this test.' });
  }
  const elapsedSeconds = businessHours.secondsBetween(latest.started_at_ns / 1e6, Date.now());
  if (elapsedSeconds < FORWARDING_TEST_BUSINESS_HOURS * 3600) {
    return res.status(409).json({ error: 'This account has not reached 36 business hours without a call.' });
  }
  const actor = actorFor(req);
  const now = new Date().toISOString();
  try {
    const insertedResult = db.transaction(() => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO bot_forwarding_checks
        (customer, last_call_id, checked_by_email, checked_by_name, notes, result, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(customer, callId, actor.email, actor.name, notes, result, now);
      if (!inserted.changes) return false;
      addEvent(callId, actor, 'forwarding_test_completed', { customer, last_call_id: callId, notes, result });
      if (result === 'not_reaching_airi') {
        const criticalNote = 'Forwarding test did not reach AIRI.';
        db.prepare(`UPDATE bot_reviews SET status = CASE WHEN status = 'reviewed' THEN 'unreviewed' ELSE status END,
          claim_expires_at = CASE WHEN status = 'reviewed' THEN NULL ELSE claim_expires_at END,
          critical = 1,
          critical_flagged_at = CASE WHEN critical = 0 THEN ? ELSE critical_flagged_at END,
          critical_note = CASE WHEN trim(critical_note) = '' THEN ? ELSE critical_note || char(10) || ? END,
          outcome = 'needs_follow_up', updated_at = ? WHERE call_id = ?`)
          .run(now, criticalNote, criticalNote, now, callId);
        addEvent(callId, actor, 'critical_flagged_by_forwarding_test', { customer, result, critical_note: criticalNote });
      }
      return true;
    })();
    if (!insertedResult) return res.status(409).json({ error: 'This forwarding test was already checked off' });
    const account = hubspotRecord.displayName || accountNameFor(customer);
    const passed = result === 'reached_airi';
    postSlack(`${slackMention('SLACK_HITSQUAD_GROUP_ID', 'hitsquad')} ${account}'s forwarding number: ${hubspotRecord.forwardingNumber || 'not on file'} has ${passed ? 'PASSED' : 'FAILED'} their forwarding check test. QA Agent that tested: ${actor.name}`);
    if (!passed) notifyCallFlag(callId, actor.name);
    res.json({ ok: true, checked_by: actor.name, checked_at: now });
  } catch (error) {
    console.error('[ai-bot-qc] forwarding test completion failed:', error.message);
    res.status(500).json({ error: 'Could not save the forwarding test completion' });
  }
});

router.post('/forwarding-checks/:id/reopen', (req, res) => {
  const checkId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(checkId) || checkId < 1) return res.status(400).json({ error: 'A valid forwarding check is required' });
  const check = db.prepare('SELECT id, customer, last_call_id, notes, result FROM bot_forwarding_checks WHERE id = ?').get(checkId);
  if (!check) return res.status(404).json({ error: 'Forwarding check not found' });
  const actor = actorFor(req);
  const reopen = db.transaction(() => {
    const removed = db.prepare('DELETE FROM bot_forwarding_checks WHERE id = ?').run(checkId).changes;
    if (!removed) return false;
    addEvent(check.last_call_id, actor, 'forwarding_test_reopened', {
      customer: check.customer,
      check_id: check.id,
      previous_notes: check.notes,
      previous_result: check.result,
    });
    return true;
  });
  if (!reopen()) return res.status(409).json({ error: 'Forwarding check was already reopened' });
  res.json({ ok: true });
});

router.get('/changes', requireRole(...QC_ROLES), (req, res) => {
  const period = ['7d', '30d', '90d'].includes(req.query.period) ? req.query.period : 'all';
  const days = { '7d': 7, '30d': 30, '90d': 90 }[period];
  const rows = db.prepare(`SELECT id, change_type, title, details, created_by_name, created_at
    FROM bot_qc_changes ${days ? "WHERE created_at >= datetime('now', ?)" : ''}
    ORDER BY id DESC LIMIT 50`).all(...(days ? [`-${days} days`] : []));
  res.json({ changes: rows });
});

router.post('/changes', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const changeType = ['prompt', 'knowledge', 'call_flow', 'model_voice', 'other'].includes(req.body?.change_type)
    ? req.body.change_type
    : '';
  const title = String(req.body?.title || '').trim().slice(0, 160);
  const details = String(req.body?.details || '').trim().slice(0, 3000);
  if (!changeType || !title) return res.status(400).json({ error: 'Choose a change type and enter a short title' });
  const actor = actorFor(req);
  const result = db.prepare(`INSERT INTO bot_qc_changes
    (change_type, title, details, created_by_email, created_by_name)
    VALUES (?, ?, ?, ?, ?)`)
    .run(changeType, title, details, actor.email, actor.name);
  const change = db.prepare(`SELECT id, change_type, title, details, created_by_name, created_at
    FROM bot_qc_changes WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ change });
});

router.get('/calls/:id', (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  res.json({ call: callRow(call), history: eventRows(call.id) });
});

// Recording-only view: audio and transcript, with no review notes, tags or reviewer details.
router.get('/calls/:id/recording', async (req, res) => {
  const call = db.prepare('SELECT * FROM bot_calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Recording not found.' });
  const keys = JSON.parse(call.recording_keys || '[]');
  const recordings = [];
  for (const key of keys) {
    let transcript = [];
    try {
      const messages = JSON.parse(await readObjectText(call.bucket, `${key.replace(/\.[^./]+$/, '')}/transcript.json`));
      if (Array.isArray(messages)) {
        transcript = messages
          .filter(message => message && message.content)
          .map(message => ({ role: String(message.role || ''), content: String(message.content).slice(0, 5000) }))
          .slice(0, 500);
      }
    } catch { /* transcript is optional */ }
    recordings.push({ key, transcript });
  }
  res.json({
    id: call.id,
    bucket: call.bucket,
    customer: call.customer,
    account_name: accountNameFor(call.customer),
    call_date: call.call_date,
    started_at_ns: call.started_at_ns,
    duration_seconds: call.started_at_ns && call.ended_at_ns ? Math.max(0, Math.round((call.ended_at_ns - call.started_at_ns) / 1e9)) : null,
    recordings,
  });
});

router.post('/calls/:id/claim', (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  const actor = actorFor(req);
  if (claimIsActive(call) && call.reviewer_email !== actor.email && !isQcAdmin(req)) {
    return res.status(409).json({ error: 'This call is currently claimed by another reviewer', reviewer_name: call.reviewer_name, claim_expires_at: call.claim_expires_at });
  }
  const previousReviewer = claimIsActive(call) && call.reviewer_email !== actor.email ? call.reviewer_name : null;
  const now = new Date();
  const expires = new Date(now.getTime() + CLAIM_MINUTES * 60_000).toISOString();
  db.prepare(`UPDATE bot_reviews SET status = 'in_review', reviewer_email = ?, reviewer_name = ?,
      claimed_at = COALESCE(claimed_at, ?), claim_expires_at = ?, updated_at = ? WHERE call_id = ?`)
    .run(actor.email, actor.name, now.toISOString(), expires, now.toISOString(), call.id);
  if (previousReviewer || !claimIsActive(call)) {
    addEvent(call.id, actor, previousReviewer ? 'claim_taken_over' : 'claimed', { expires_at: expires, previous_reviewer: previousReviewer });
  }
  res.json({ ok: true, call: callRow(requireCall(req, res)) });
});

router.put('/calls/:id/draft', (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  const actor = actorFor(req);
  if (!ownsActiveClaim(call, actor, isQcAdmin(req))) {
    return res.status(409).json({ error: 'This call is being reviewed by another person', reviewer_name: call.reviewer_name });
  }
  const feedback = String(req.body?.feedback || '').slice(0, 10000);
  const callTags = normalizedCallTags(req.body?.call_tags, JSON.parse(call.call_tags || '[]'));
  const callerHappiness = normalizedHappiness(req.body?.caller_happiness, call.caller_happiness);
  const critical = req.body?.critical ? 1 : 0;
  const criticalNote = String(req.body?.critical_note || '').slice(0, 2000);
  const requestedOutcome = req.body?.outcome;
  const outcome = critical || requestedOutcome === 'needs_follow_up' ? 'needs_follow_up' : null;
  if (requestedOutcome && !['ok', 'needs_follow_up'].includes(requestedOutcome)) {
    return res.status(400).json({ error: 'Choose a valid review outcome.' });
  }
  if (outcome === 'needs_follow_up' && !critical && !callTags.some(tag => FOLLOW_UP_TAGS.includes(tag)) && !feedback.trim()) {
    return res.status(400).json({ error: 'Add a relevant caller signal or reviewer note before marking this call for follow-up.' });
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE bot_reviews SET status = 'in_review', feedback = ?, call_tags = ?, caller_happiness = ?, critical = ?, critical_flagged_at = CASE
      WHEN ? = 1 AND critical = 0 THEN ? WHEN ? = 0 THEN NULL ELSE critical_flagged_at END,
      critical_note = ?, outcome = ?,
      reviewer_email = ?, reviewer_name = ?, last_saved_at = ?, claim_expires_at = ?, updated_at = ? WHERE call_id = ?`)
    .run(feedback, JSON.stringify(callTags), callerHappiness, critical, critical, now, critical, criticalNote, outcome, actor.email, actor.name, now, new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString(), now, call.id);
  if (feedback !== call.feedback || JSON.stringify(callTags) !== JSON.stringify(JSON.parse(call.call_tags || '[]')) || callerHappiness !== call.caller_happiness || critical !== call.critical || criticalNote !== call.critical_note || outcome !== call.outcome) {
    addEvent(call.id, actor, 'draft_saved', {
      feedback_changed: feedback !== call.feedback,
      call_tags_changed: JSON.stringify(callTags) !== JSON.stringify(JSON.parse(call.call_tags || '[]')),
      caller_happiness_changed: callerHappiness !== call.caller_happiness,
      critical_changed: critical !== call.critical,
      outcome_changed: outcome !== call.outcome,
    });
  }
  res.json({ ok: true, saved_at: now });
});

router.post('/calls/:id/release', (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  const actor = actorFor(req);
  if (call.status !== 'in_review' || call.reviewer_email !== actor.email) {
    return res.json({ ok: true, released: false });
  }
  const feedback = String(req.body?.feedback ?? call.feedback ?? '').slice(0, 10000);
  const callTags = normalizedCallTags(req.body?.call_tags, JSON.parse(call.call_tags || '[]'));
  const callerHappiness = normalizedHappiness(req.body?.caller_happiness, call.caller_happiness);
  const critical = req.body?.critical === undefined ? (call.critical ? 1 : 0) : (req.body.critical ? 1 : 0);
  const criticalNote = String(req.body?.critical_note ?? call.critical_note ?? '').slice(0, 2000);
  const outcome = critical ? 'needs_follow_up' : null;
  const now = new Date().toISOString();
  const release = db.transaction(() => {
    db.prepare(`UPDATE bot_reviews SET status = 'unreviewed', feedback = ?, call_tags = ?, caller_happiness = ?, critical = ?, critical_flagged_at = CASE
        WHEN ? = 1 AND critical = 0 THEN ? WHEN ? = 0 THEN NULL ELSE critical_flagged_at END,
        critical_note = ?, outcome = ?, reviewer_email = ?, reviewer_name = ?,
        last_saved_at = ?, claim_expires_at = NULL, updated_at = ? WHERE call_id = ?`)
      .run(feedback, JSON.stringify(callTags), callerHappiness, critical, critical, now, critical, criticalNote, outcome,
        actor.email, actor.name, now, now, call.id);
    addEvent(call.id, actor, 'released', { draft_saved: true });
  });
  release();
  res.json({ ok: true, released: true, saved_at: now });
});

router.post('/calls/:id/complete', (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  const actor = actorFor(req);
  const callTags = normalizedCallTags(req.body?.call_tags, JSON.parse(call.call_tags || '[]'));
  const callerHappiness = normalizedHappiness(req.body?.caller_happiness, call.caller_happiness);
  const critical = req.body?.critical === undefined ? (call.critical ? 1 : 0) : (req.body.critical ? 1 : 0);
  const criticalNote = String(req.body?.critical_note ?? call.critical_note ?? '').slice(0, 2000);
  const requestedOutcome = req.body?.outcome;
  const outcome = critical || requestedOutcome === 'needs_follow_up' ? 'needs_follow_up' : null;
  const feedback = String(req.body?.feedback ?? call.feedback ?? '').slice(0, 10000);
  if (requestedOutcome && !['ok', 'needs_follow_up'].includes(requestedOutcome)) {
    return res.status(400).json({ error: 'Choose a valid review outcome.' });
  }
  if (outcome === 'needs_follow_up' && !critical && !callTags.some(tag => FOLLOW_UP_TAGS.includes(tag)) && !feedback.trim()) {
    return res.status(400).json({ error: 'Add a relevant caller signal or reviewer note before marking this call for follow-up.' });
  }
  if (critical && !criticalNote.trim()) {
    return res.status(400).json({ error: 'Add critical issue detail before completing this review' });
  }
  if (!critical && !callTags.length && !callerHappiness && !feedback.trim()) {
    return res.status(400).json({ error: 'Choose a caller happiness rating, add a caller signal, or add reviewer notes' });
  }
  if (!ownsActiveClaim(call, actor, isQcAdmin(req))) {
    return res.status(409).json({ error: 'This call is being reviewed by another person', reviewer_name: call.reviewer_name });
  }
  const now = new Date().toISOString();
  const complete = db.transaction(() => {
    db.prepare(`UPDATE bot_reviews SET status = 'reviewed', outcome = ?, caller_happiness = ?, feedback = ?, call_tags = ?, critical = ?,
        critical_flagged_at = CASE WHEN ? = 1 AND critical = 0 THEN ? WHEN ? = 0 THEN NULL ELSE critical_flagged_at END, critical_note = ?,
        reviewer_email = ?, reviewer_name = ?, reviewed_at = ?, last_saved_at = ?, claim_expires_at = NULL, updated_at = ? WHERE call_id = ?`)
      .run(outcome, callerHappiness, feedback, JSON.stringify(callTags), critical, critical, now, critical, criticalNote, actor.email, actor.name, now, now, now, call.id);
    addEvent(call.id, actor, 'reviewed', { outcome, critical: Boolean(critical), caller_happiness: callerHappiness, call_tags: callTags });
  });
  complete();
  notifyCallFlag(call.id);
  res.json({ ok: true, reviewed_at: now });
});

router.post('/calls/:id/reopen', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  const actor = actorFor(req);
  const now = new Date().toISOString();
  db.prepare(`UPDATE bot_reviews SET status = 'unreviewed', claim_expires_at = NULL, updated_at = ? WHERE call_id = ?`)
    .run(now, call.id);
  addEvent(call.id, actor, 'reopened');
  res.json({ ok: true });
});

router.post('/calls/resolve-critical-bulk', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.call_ids) ? req.body.call_ids : []).filter(id => typeof id === 'string'))].slice(0, 200);
  const note = String(req.body?.resolution_note || '').trim().slice(0, 1000);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one call.' });
  if (!note) return res.status(400).json({ error: 'Add a note describing what was addressed.' });
  const actor = actorFor(req);
  const now = new Date().toISOString();
  let resolved = 0;
  db.transaction(() => {
    for (const id of ids) {
      const row = db.prepare('SELECT critical FROM bot_reviews WHERE call_id = ?').get(id);
      if (!row?.critical) continue;
      db.prepare(`UPDATE bot_reviews SET status = 'reviewed', outcome = 'ok', critical = 0,
          reviewed_at = COALESCE(reviewed_at, ?), claim_expires_at = NULL, updated_at = ? WHERE call_id = ?`).run(now, now, id);
      addEvent(id, actor, 'critical_resolved', { resolution_note: note, bulk: true });
      resolved += 1;
    }
  })();
  res.json({ ok: true, resolved, skipped: ids.length - resolved });
});

router.post('/calls/:id/resolve-critical', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const call = requireCall(req, res);
  if (!call) return;
  if (!call.critical) return res.status(409).json({ error: 'This call no longer has an active critical flag.' });
  const resolutionNote = String(req.body?.resolution_note || '').trim().slice(0, 1000);
  if (!resolutionNote) return res.status(400).json({ error: 'Add a note describing what was addressed.' });
  const actor = actorFor(req);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE bot_reviews SET status = 'reviewed', outcome = 'ok', critical = 0,
        reviewed_at = COALESCE(reviewed_at, ?), claim_expires_at = NULL, updated_at = ? WHERE call_id = ?`)
      .run(now, now, call.id);
    addEvent(call.id, actor, 'critical_resolved', { resolution_note: resolutionNote });
  })();
  res.json({ ok: true, resolved_at: now });
});

async function countableCallFilter() {
  let inactive = [];
  try { inactive = await hubspotInactiveCustomers(); } catch (error) {
    console.error('[ai-bot-qc] HubSpot AIRI status lookup failed for counts:', error.response?.status || error.message);
  }
  return inactive.length
    ? { sql: `${NOT_INTERNAL_TEST_SQL} AND c.customer NOT IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(inactive)] }
    : { sql: NOT_INTERNAL_TEST_SQL, params: [] };
}

router.get('/queue-summary', async (req, res) => {
  releaseExpiredClaims();
  const base = await countableCallFilter();
  const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(r.status = 'unreviewed') AS unreviewed,
      SUM(r.status = 'in_review') AS in_review,
      SUM(r.status = 'reviewed') AS reviewed,
      SUM(r.status = 'reviewed' AND (r.outcome = 'needs_follow_up' OR r.critical = 1)) AS needs_follow_up,
      SUM(r.critical = 1) AS critical
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    WHERE ${base.sql}`).get(...base.params);
  res.json({ counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value || 0])) });
});

router.get('/dashboard', requireRole(...QC_ADMIN_ROLES), async (req, res) => {
  releaseExpiredClaims();
  const base = await countableCallFilter();
  const period = ['7d', '30d', '90d'].includes(req.query.period) ? req.query.period : 'all';
  const reviewerEmail = typeof req.query.reviewer_email === 'string' && req.query.reviewer_email !== 'all'
    ? req.query.reviewer_email.trim().slice(0, 180)
    : '';
  const filters = [base.sql];
  const filterParams = [...base.params];
  const periodDays = { '7d': 7, '30d': 30, '90d': 90 }[period];
  if (periodDays) {
    filters.push("r.reviewed_at >= datetime('now', ?)");
    filterParams.push(`-${periodDays} days`);
  }
  if (reviewerEmail) {
    filters.push('r.reviewer_email = ?');
    filterParams.push(reviewerEmail);
  }
  const scopedWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const scopedReviewTotals = db.prepare(`SELECT COUNT(*) AS reviewed, SUM(r.critical = 1) AS critical
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    ${filters.length ? `WHERE r.status = 'reviewed' AND ${filters.join(' AND ')}` : "WHERE r.status = 'reviewed'"}`)
    .get(...filterParams);
  const total = db.prepare(`SELECT COUNT(*) AS total,
      SUM(r.status = 'unreviewed') AS unreviewed,
      SUM(r.status = 'in_review') AS in_review,
      SUM(r.status = 'reviewed') AS reviewed,
      SUM(r.status = 'reviewed' AND (r.outcome = 'needs_follow_up' OR r.critical = 1)) AS needs_follow_up,
      SUM(r.critical = 1) AS critical
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    WHERE ${base.sql}`).get(...base.params);
  const accounts = db.prepare(`SELECT c.customer, COUNT(*) AS calls,
      SUM(r.status = 'reviewed') AS reviewed,
      SUM(r.status = 'reviewed' AND (r.outcome = 'needs_follow_up' OR r.critical = 1 OR EXISTS (
        SELECT 1 FROM json_each(r.call_tags) WHERE value IN ('bot_hangup','intent_misunderstood','handoff_needed','incorrect_information')
      ))) AS issues,
      SUM(r.critical = 1) AS critical,
      AVG(CASE WHEN r.status = 'reviewed' THEN r.caller_happiness END) AS avg_caller_happiness,
      SUM(r.status = 'reviewed' AND r.caller_happiness IS NOT NULL) AS rated_calls,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'bot_hangup')) AS bot_hangups,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'intent_misunderstood')) AS intent_misunderstood,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'incorrect_information')) AS incorrect_information,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'handoff_needed')) AS handoff_needed,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'greeting_only')) AS greeting_only,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'no_interaction')) AS no_interaction,
      SUM(r.status = 'reviewed' AND EXISTS (SELECT 1 FROM json_each(r.call_tags) WHERE value = 'sales_spam')) AS sales_spam
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id
    ${scopedWhere}
    GROUP BY c.customer ORDER BY critical DESC, issues DESC, calls DESC`).all(...filterParams);
  const reviewers = db.prepare(`SELECT reviewer_email, reviewer_name,
      COUNT(*) AS assigned_calls,
      SUM(r.status = 'reviewed') AS completed,
      SUM(r.status = 'reviewed' AND (r.outcome = 'needs_follow_up' OR r.critical = 1 OR EXISTS (
        SELECT 1 FROM json_each(r.call_tags) WHERE value IN ('bot_hangup','intent_misunderstood','handoff_needed','incorrect_information')
      ))) AS issues_found,
      SUM(r.critical = 1) AS critical_found,
      AVG(CASE WHEN r.status = 'reviewed' THEN r.caller_happiness END) AS avg_caller_happiness,
      SUM(r.status = 'reviewed' AND r.caller_happiness IS NOT NULL) AS rated_calls,
      MAX(r.reviewed_at) AS last_reviewed_at
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    ${filters.length ? `WHERE r.reviewer_email IS NOT NULL AND ${filters.join(' AND ')}` : 'WHERE r.reviewer_email IS NOT NULL'}
    GROUP BY r.reviewer_email ORDER BY completed DESC, r.reviewer_name COLLATE NOCASE`).all(...filterParams);
  const tagCounts = db.prepare(`SELECT tags.value AS tag, COUNT(*) AS count
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id, json_each(r.call_tags) AS tags
    ${scopedWhere}
    GROUP BY tags.value`).all(...filterParams);
  const happinessCounts = db.prepare(`SELECT r.caller_happiness AS rating, COUNT(*) AS count
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    ${scopedWhere}${scopedWhere ? ' AND' : ' WHERE'} r.status = 'reviewed' AND r.caller_happiness IS NOT NULL
    GROUP BY r.caller_happiness ORDER BY r.caller_happiness`).all(...filterParams);
  const feedbackNotes = db.prepare(`SELECT c.customer, r.reviewer_name, r.reviewer_email, r.feedback,
      r.caller_happiness, r.call_tags, r.critical, r.reviewed_at
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    ${filters.length ? `WHERE r.status = 'reviewed' AND r.feedback != '' AND ${filters.join(' AND ')}` : "WHERE r.status = 'reviewed' AND r.feedback != ''"}
    ORDER BY r.reviewed_at DESC LIMIT 20`).all(...filterParams)
    .map(note => ({ ...note, call_tags: JSON.parse(note.call_tags || '[]') }));
  const feedbackNotesCount = db.prepare(`SELECT COUNT(*) AS count FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id
    ${filters.length ? `WHERE r.status = 'reviewed' AND r.feedback != '' AND ${filters.join(' AND ')}` : "WHERE r.status = 'reviewed' AND r.feedback != ''"}`)
    .get(...filterParams).count;
  const botHealth = {
    reviewed: scopedReviewTotals.reviewed || 0,
    issueReviews: reviewers.reduce((sum, reviewer) => sum + (reviewer.issues_found || 0), 0),
    averageHappiness: happinessCounts.length
      ? happinessCounts.reduce((sum, item) => sum + item.rating * item.count, 0) / happinessCounts.reduce((sum, item) => sum + item.count, 0)
      : null,
    botHangups: tagCounts.find(item => item.tag === 'bot_hangup')?.count || 0,
    incorrectInformation: tagCounts.find(item => item.tag === 'incorrect_information')?.count || 0,
    critical: scopedReviewTotals.critical || 0,
  };
  const reviewerOptions = db.prepare(`SELECT DISTINCT r.reviewer_email, r.reviewer_name FROM bot_reviews r
    JOIN bot_calls c ON c.id = r.call_id
    WHERE r.reviewer_email IS NOT NULL AND ${base.sql}
    ORDER BY r.reviewer_name COLLATE NOCASE`).all(...base.params);
  const today = localDayBounds();
  const activity = db.prepare(`SELECT
      SUM(r.status = 'reviewed' AND r.reviewed_at >= ? AND r.reviewed_at < ?) AS calls_reviewed_today,
      MAX(CASE WHEN r.status = 'reviewed' THEN r.reviewed_at END) AS last_call_checked_at
    FROM bot_reviews r JOIN bot_calls c ON c.id = r.call_id WHERE ${base.sql}`)
    .get(today.start, today.end, ...base.params);
  const criticalFlags = db.prepare(`SELECT c.*, r.status, r.outcome, r.caller_happiness, r.feedback, r.call_tags, r.critical, r.critical_note,
      r.reviewer_email, r.reviewer_name, r.assigned_to_email, r.assigned_to_name, r.assigned_by_email, r.assigned_by_name, r.assigned_at,
      r.claimed_at, r.claim_expires_at, r.last_saved_at, r.reviewed_at, r.updated_at,
      ${IS_INTERNAL_TEST_SQL} AS is_internal_test
    FROM bot_calls c JOIN bot_reviews r ON r.call_id = c.id
    WHERE r.critical = 1 AND ${base.sql} ORDER BY COALESCE(r.critical_flagged_at, r.updated_at) DESC LIMIT 200`)
    .all(...base.params).map(callRow);
  res.json({
    counts: Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value || 0])),
    accounts,
    reviewers,
    tag_counts: Object.fromEntries(tagCounts.map(item => [item.tag, item.count])),
    caller_happiness_counts: Object.fromEntries(happinessCounts.map(item => [item.rating, item.count])),
    feedback_notes: feedbackNotes,
    feedback_notes_count: feedbackNotesCount,
    bot_health: botHealth,
    reviewer_options: reviewerOptions,
    activity: { calls_reviewed_today: activity.calls_reviewed_today || 0, last_call_checked_at: activity.last_call_checked_at || null },
    critical_flags: criticalFlags,
    period,
    reviewer_email: reviewerEmail || 'all',
  });
});

router.get('/history', requireRole(...QC_ADMIN_ROLES), (req, res) => {
  const rows = db.prepare(`SELECT e.*, c.customer, c.call_date, c.started_at_ns, c.object_key
    FROM bot_review_events e JOIN bot_calls c ON c.id = e.call_id
    WHERE ${NOT_INTERNAL_TEST_SQL}
    ORDER BY e.id DESC LIMIT 500`).all();
  res.json({ events: rows.map(event => ({ ...event, details: JSON.parse(event.details || '{}') })) });
});

router.get('/buckets', async (req, res) => {
  if (!needStorage(res)) return;
  try {
    res.json({ buckets: await discoverBuckets() });
  } catch (error) {
    console.error('[ai-bot-qc] bucket discovery failed:', error.message);
    res.status(502).json({ error: 'Could not discover buckets. The key may not have permission to list buckets; set IDRIVE_E2_BUCKET to select one directly.' });
  }
});

router.get('/customers', async (req, res) => {
  if (!needStorage(res)) return;
  try {
    const bucket = await resolveBucket(req);
    if (!bucket) return res.status(400).json({ error: 'Choose a valid bucket first' });
    const entries = await listAll(bucket, { Prefix: ARCHIVE_PREFIX, Delimiter: '/' });
    const customers = entries.filter(entry => entry.Prefix)
      .map(entry => entry.Prefix.slice(ARCHIVE_PREFIX.length, -1))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    res.json({ customers });
  } catch (error) {
    storageFailure(res, error, 'Could not list customer folders from iDrive e2', 's3:ListBucket');
  }
});

router.get('/dates', async (req, res) => {
  const customer = safeSegment(req.query.customer);
  if (!customer) return res.status(400).json({ error: 'A valid customer folder is required' });
  if (!needStorage(res)) return;
  try {
    const bucket = await resolveBucket(req);
    if (!bucket) return res.status(400).json({ error: 'Choose a valid bucket first' });
    const customerPrefix = `${ARCHIVE_PREFIX}${customer}/`;
    const entries = await listAll(bucket, { Prefix: customerPrefix, Delimiter: '/' });
    const dates = entries.filter(entry => entry.Prefix)
      .map(entry => entry.Prefix.slice(customerPrefix.length, -1))
      .filter(Boolean)
      .sort()
      .reverse();
    res.json({ dates });
  } catch (error) {
    storageFailure(res, error, 'Could not list date folders from iDrive e2', 's3:ListBucket');
  }
});

router.get('/files', async (req, res) => {
  const date = safeSegment(req.query.date);
  const customer = safeSegment(req.query.customer);
  if (!date || !customer) return res.status(400).json({ error: 'Date and customer folders are required' });
  const calls = db.prepare(`SELECT c.object_key, c.recording_keys FROM bot_calls c
    WHERE c.customer = ? AND c.call_date = ?`).all(customer, date);
  const allowedKeys = new Set();
  for (const call of calls) {
    allowedKeys.add(call.object_key);
    for (const key of JSON.parse(call.recording_keys || '[]')) allowedKeys.add(key);
  }
  if (!needStorage(res)) return;
  try {
    const bucket = await resolveBucket(req);
    if (!bucket) return res.status(400).json({ error: 'Choose a valid bucket first' });
    const prefix = `${ARCHIVE_PREFIX}${customer}/${date}/`;
    const files = (await listAll(bucket, { Prefix: prefix }))
      .filter(entry => entry.Key && entry.Key !== prefix && allowedKeys.has(entry.Key))
      .map(entry => ({
        key: entry.Key,
        name: entry.Key.slice(prefix.length),
        size: entry.Size,
        lastModified: entry.LastModified,
      }));
    res.json({ files });
  } catch (error) {
    storageFailure(res, error, 'Could not list customer files from iDrive e2', 's3:ListBucket');
  }
});

router.get('/artifact', async (req, res) => {
  const download = req.query.download === '1';
  const userRoles = [req.user?.role, ...(req.user?.additionalRoles || [])];
  if (download && !userRoles.some(role => QC_ADMIN_ROLES.includes(role))) {
    return res.status(403).json({ error: 'Only AIRI QA admins can download recordings' });
  }
  const date = safeSegment(req.query.date);
  const customer = safeSegment(req.query.customer);
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const artifactPrefix = date && customer ? `${ARCHIVE_PREFIX}${customer}/${date}/` : '';
  if (!date || !customer || !key.startsWith(artifactPrefix) || key.length > 1024) {
    return res.status(400).json({ error: 'Invalid artifact path' });
  }
  const visibleCallFile = db.prepare(`SELECT 1 FROM bot_calls c
    WHERE c.customer = ? AND c.call_date = ?
      AND (c.object_key = ? OR EXISTS (
        SELECT 1 FROM json_each(c.recording_keys) AS recording WHERE recording.value = ?
      ))
    LIMIT 1`).get(customer, date, key, key);
  if (!visibleCallFile) return res.status(404).json({ error: 'Recording file not found.' });
  if (!needStorage(res)) return;
  try {
    const bucket = await resolveBucket(req);
    if (!bucket) return res.status(400).json({ error: 'Choose a valid bucket first' });
    const command = new GetObjectCommand({ Bucket: bucket, Key: key, Range: req.headers.range });
    const object = await getClient().send(command);
    if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
    if (object.ContentLength != null) res.setHeader('Content-Length', object.ContentLength);
    if (download) {
      const filename = key.split('/').pop().replace(/[\r\n"\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
    if (object.ContentRange) res.setHeader('Content-Range', object.ContentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(object.ContentRange ? 206 : 200);
    object.Body.pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    storageFailure(res, error, 'Could not open this artifact', 's3:GetObject');
  }
});

setInterval(() => {
  notifyDueForwardingChecks().catch(error => console.error('[ai-bot-qc] forwarding notice failed:', error.message));
}, 10 * 60_000).unref();

module.exports = router;
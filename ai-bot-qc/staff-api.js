const https = require('https');
const axios = require('axios');

const CACHE_MS = 5 * 60 * 1000;
const CONCURRENCY = 3;
let cache = { at: 0, accounts: null };
let inflight = null;

function client() {
  const key = process.env.STAFF_API_KEY;
  if (!key) throw Object.assign(new Error('STAFF_API_KEY is not set'), { code: 'not_configured' });
  return axios.create({
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY }),
    baseURL: (process.env.STAFF_API_BASE || 'https://staff-api.staging-answeringai.cticloud.us').replace(/\/$/, ''),
    headers: { 'x-staff-api-key': key },
    timeout: 15000,
  });
}

// Retries on 429, honouring Retry-After (the API allows 120 requests a minute).
async function get(http, url, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await http.get(url, { params })).data;
    } catch (error) {
      if (error.response?.status !== 429 || attempt >= 4) throw error;
      const wait = Math.min(Number(error.response.headers['retry-after']) || 5, 60) * 1000;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

// Contact names are not a documented field; use the first transfer target name if the config carries one.
function contactFrom(config) {
  const targets = config?.transfer_targets || config?.transferTargets || [];
  const first = Array.isArray(targets) ? targets.find(t => t?.name) : null;
  return first?.name ? String(first.name) : '';
}

async function fetchAccounts() {
  const http = client();
  const summaries = [];
  let cursor = null;
  do {
    const page = await get(http, '/v1/accounts', { limit: 200, ...(cursor ? { cursor } : {}) });
    summaries.push(...page.accounts);
    cursor = page.next_cursor;
  } while (cursor);

  const enabled = summaries.filter(a => !a.disabled);
  const accounts = [];
  let index = 0;
  async function worker() {
    while (index < enabled.length) {
      const summary = enabled[index++];
      const body = await get(http, `/v1/accounts/${summary.id}`);
      const detail = body.account || body;
      const dids = (detail.dids || []).filter(d => d.active).map(d => d.e164);
      if (!dids.length) continue;
      accounts.push({
        customer: summary.id,
        name: detail.name || summary.name,
        did: dids[0],
        dids,
        did_source: 'staging',
        contact: contactFrom(detail.config),
        last_call_date: summary.last_call_at ? summary.last_call_at.slice(0, 10) : '',
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

// Cached because each account's DIDs need their own request (120 requests/minute limit).
async function listStagingAccounts({ refresh = false } = {}) {
  if (!refresh && cache.accounts && Date.now() - cache.at < CACHE_MS) return cache.accounts;
  if (!inflight) {
    inflight = fetchAccounts()
      .then(accounts => { cache = { at: Date.now(), accounts }; return accounts; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const last10 = value => String(value || '').replace(/\D/g, '').slice(-10);

// Newest-first scan of recent calls, stopping once calls are older than `sinceMs`.
async function recentCalls({ sinceMs, maxPages = 5 }) {
  const http = client();
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const params = { limit: 200, from: day(sinceMs - 86400000), to: day(Date.now() + 86400000) };
  const found = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await get(http, '/v1/calls', { ...params, ...(cursor ? { cursor } : {}) });
    found.push(...body.calls);
    cursor = body.next_cursor;
    const oldest = body.calls[body.calls.length - 1];
    if (!cursor || !oldest || Date.parse(oldest.started_at) < sinceMs) break;
  }
  return found.filter(call => call.kind === 'inbound' && Date.parse(call.started_at) >= sinceMs);
}

async function getCall(id) {
  const body = await get(client(), `/v1/calls/${encodeURIComponent(id)}`);
  return body.call || body;
}

// A call that filed no lead answers 404; that is reported as null.
async function getLead(id) {
  try {
    const body = await get(client(), `/v1/calls/${encodeURIComponent(id)}/lead`);
    return body.lead || body;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

// Pages through /v1/calls (newest first). `complete` is false when maxPages stopped the walk early.
async function listCalls(params, { maxPages = 50 } = {}) {
  const http = client();
  const calls = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const body = await get(http, '/v1/calls', { limit: 200, ...params, ...(cursor ? { cursor } : {}) });
    calls.push(...body.calls);
    cursor = body.next_cursor;
    if (!cursor) return { calls, complete: true };
  }
  return { calls, complete: false };
}

async function listAccountSummaries() {
  const http = client();
  const accounts = [];
  let cursor = null;
  do {
    const page = await get(http, '/v1/accounts', { limit: 200, ...(cursor ? { cursor } : {}) });
    accounts.push(...page.accounts);
    cursor = page.next_cursor;
  } while (cursor);
  return accounts;
}

// Streams the audio through the server; the signed link is never sent to the browser.
async function openRecording(id, range) {
  const url = await recordingUrl(id);
  if (!url) return null;
  return axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    headers: range ? { Range: range } : {},
    validateStatus: status => status === 200 || status === 206,
  });
}

// Recording links expire after an hour and must not be stored; keep one briefly in memory only.
const linkCache = new Map();
async function recordingUrl(id) {
  const hit = linkCache.get(id);
  if (hit && hit.until > Date.now()) return hit.url;
  const url = (await getCall(id)).recording_url || null;
  if (url) linkCache.set(id, { url, until: Date.now() + 45 * 60 * 1000 });
  return url;
}

module.exports = { listStagingAccounts, listAccountSummaries, listCalls, recentCalls, getCall, getLead, recordingUrl, openRecording, last10 };

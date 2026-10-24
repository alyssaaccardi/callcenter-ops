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

module.exports = { listStagingAccounts };

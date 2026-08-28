/**
 * Belize Grid Watch — server routes.
 *
 *   GET /api/grid/roster    Monday.com GraphQL -> [{ name, address, town, district }]
 *   GET /api/grid/outages   Anthropic + web_search -> { grid_status, grid_note, outages[] }
 *
 * Both keys stay on the server. Never ship either to the browser.
 *
 * Env:
 *   ANTHROPIC_API_KEY   required
 *   MONDAY_API_TOKEN    required
 *   GRID_BOARD_ID       default 18415794851
 *   GRID_GROUP_MATCH    default "Active Employee Addresses"
 *
 * Requires Node 18+ (native fetch).
 */

import express from "express";
import multer from "multer";
import path from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { DISTRICTS, placeOf, TOWN_COORDS, norm } from "./client/src/lib/belize-places.mjs";
import { fetchPowerUpdates } from "./bel-scraper.mjs";

const MANUAL_STORE = "./grid-manual-outages.json";
const NOTIFIED_STORE = "./grid-notified-outages.json";
const ATTACH_DIR = "./grid-attachments";
if (!existsSync(ATTACH_DIR)) mkdirSync(ATTACH_DIR, { recursive: true });

// Slack notification config. If SLACK_GRID_WATCH_URL is unset the
// notifier is a no-op; log is kept so we don't renotify a known outage.
const SLACK_URL = process.env.SLACK_GRID_WATCH_URL || "";

function loadNotified() {
  try {
    if (!existsSync(NOTIFIED_STORE)) return new Set();
    return new Set(JSON.parse(readFileSync(NOTIFIED_STORE, "utf8")));
  } catch { return new Set(); }
}
function saveNotified(set) {
  // Keep the file bounded — outages don't recur under the same id but
  // trimming to the last 500 avoids unbounded growth over years.
  const arr = [...set];
  const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
  writeFileSync(NOTIFIED_STORE, JSON.stringify(trimmed, null, 2));
}

const BZ_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Belize",
  weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
});
const fmtBZ = (iso) => (iso ? `${BZ_FMT.format(new Date(iso))} BZ` : "?");

// Location-based affected roster for a single outage — same tier logic
// as the JSX side. Server can only do this level since the schedule
// isn't uploaded here; that's fine for the Slack heads-up.
function affectedFor(outage, roster) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const areaNames = (outage.areaPlaces || []).map((p) => norm(p.raw)).filter((x) => x.length >= 4);
  const exNames = (outage.excludePlaces || outage.excludes || []).map((p) => norm(p.raw ?? p)).filter((x) => x.length >= 4);
  const wide = outage.district_wide || areaNames.length === 0;
  const confirmed = [];
  const monitoring = [];
  for (const a of roster) {
    if (!a.district || !outage.districts.includes(a.district)) continue;
    const t = norm(a.town || "");
    const exempt = t.length >= 4 && exNames.some((n) => n.includes(t) || t.includes(n));
    if (exempt) continue;
    const named = t.length >= 4 && areaNames.some((n) => n.includes(t) || t.includes(n));
    if (wide || named) confirmed.push(a);
    else monitoring.push(a);
  }
  return { confirmed, monitoring };
}

async function slackNotifyOutage(outage, roster) {
  if (!SLACK_URL) return;
  const { confirmed, monitoring } = affectedFor(outage, roster);
  const bullet = (a) => `• *${a.name}* — ${a.town || a.district}`;
  const list = (arr, cap = 15) => {
    if (!arr.length) return "_none_";
    if (arr.length <= cap) return arr.map(bullet).join("\n");
    return arr.slice(0, cap).map(bullet).join("\n") + `\n_+ ${arr.length - cap} more_`;
  };
  const isLive = new Date(outage.start) <= new Date();
  const emoji = outage.type === "load_shedding" ? ":zap:" : outage.type === "isp_outage" ? ":globe_with_meridians:" : ":electric_plug:";
  const status = isLive ? ":rotating_light: *LIVE*" : ":hourglass_flowing_sand: *Upcoming*";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} New outage · ${outage.districts.join(" · ")}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${status}   *Source:* ${outage.source || "unknown"}\n*Window:* ${fmtBZ(outage.start)} → ${outage.end ? fmtBZ(outage.end) : "?"}${outage.cause ? `\n*Cause:* ${outage.cause}` : ""}`,
      },
    },
  ];
  if (outage.areaPlaces?.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Areas:* ${outage.areaPlaces.slice(0, 12).map((p) => p.raw).join(", ")}${outage.areaPlaces.length > 12 ? ` + ${outage.areaPlaces.length - 12} more` : ""}` }],
    });
  }
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*To replace* (${confirmed.length})\n${list(confirmed)}` },
  });
  if (monitoring.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Monitor* (${monitoring.length}) — right district, town not named\n${list(monitoring, 8)}` },
    });
  }
  if (outage.source_url) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${outage.source_url}|Source link>` }],
    });
  }

  try {
    // Optional channel override — modern Slack apps often ignore this,
    // but classic/legacy webhooks respect it. Configure with
    // SLACK_GRID_WATCH_CHANNEL if the webhook was created for a
    // different channel than you want the alerts in.
    const payload = {
      text: `New outage · ${outage.districts.join(" · ")} · ${confirmed.length} to replace`,
      blocks,
    };
    if (process.env.SLACK_GRID_WATCH_CHANNEL) payload.channel = process.env.SLACK_GRID_WATCH_CHANNEL;
    const r = await fetch(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error("Grid Watch Slack:", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("Grid Watch Slack failed:", e.message);
  }
}

async function notifyNewOutages(outages, roster) {
  if (!SLACK_URL) return;
  // First run — the notified store doesn't exist yet. Seed it with all
  // current outage ids WITHOUT sending Slack messages; otherwise every
  // outage on the board when Slack is first turned on would fire a
  // notification, spamming the channel.
  const firstRun = !existsSync(NOTIFIED_STORE);
  const notified = loadNotified();
  const fresh = outages.filter((o) => o.id && !notified.has(o.id));
  if (!fresh.length) return;
  for (const o of fresh) {
    if (!firstRun) await slackNotifyOutage(o, roster);
    notified.add(o.id);
  }
  saveNotified(notified);
  if (firstRun) console.log(`Grid Watch: seeded ${fresh.length} existing outages, notifications will fire on next new arrival.`);
}

const VALID_ISP_SOURCES = ["DigiBelize", "Smart", "Centaur Communications", "Nexgen", "Beeline", "BEL", "Other"];

// Screenshots / evidence files uploaded with manual outages. Cap size and
// count so the disk doesn't get abused. Filenames are randomized on disk
// to avoid collisions; original name is kept in metadata for display.
const upload = multer({
  storage: multer.diskStorage({
    destination: ATTACH_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 8);
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

function loadManual() {
  try {
    if (!existsSync(MANUAL_STORE)) return [];
    return JSON.parse(readFileSync(MANUAL_STORE, "utf8"));
  } catch { return []; }
}
function saveManual(list) {
  writeFileSync(MANUAL_STORE, JSON.stringify(list, null, 2));
}

const router = express.Router();

const BOARD_ID = process.env.GRID_BOARD_ID || "18415794851";
const GROUP_MATCH = process.env.GRID_GROUP_MATCH ?? "Active Employee Addresses";
// Status column on the Belize Employee Address board — only rows with
// "Active" here should feed the affected-staff logic. Anyone marked
// Inactive doesn't work here anymore and must not surface as a person
// to replace during an outage.
const STATUS_COLUMN_ID = process.env.GRID_STATUS_COLUMN_ID || "color_mm6m75qj";
const STATUS_ACTIVE_LABEL = process.env.GRID_STATUS_ACTIVE_LABEL || "Active";

/* ------------------------------- cache -------------------------------- */
const cache = new Map();
const getCached = (k, ttlMs) => {
  const hit = cache.get(k);
  return hit && Date.now() - hit.at < ttlMs ? hit.val : null;
};
const setCached = (k, val) => cache.set(k, { at: Date.now(), val });

/* ------------------------------- roster ------------------------------- */
// Deterministic: no LLM. The board's address columns are inconsistent —
// some rows put the village in column 2, others in column 3 — so we
// concatenate every text column and let placeOf() sort it out.
const ROSTER_QUERY = `
  query ($board: ID!) {
    boards(ids: [$board]) {
      name
      items_page(limit: 500) {
        cursor
        items {
          id
          name
          group { title }
          column_values { id text }
        }
      }
    }
  }`;

async function fetchRoster() {
  const cached = getCached("roster", 10 * 60 * 1000);
  if (cached) return cached;

  const token = process.env.MONDAY_API_TOKEN || process.env.MONDAY_API_KEY;
  if (!token) throw new Error("MONDAY_API_TOKEN (or MONDAY_API_KEY) is not set");

  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query: ROSTER_QUERY, variables: { board: BOARD_ID } }),
  });
  if (!res.ok) throw new Error(`monday.com returned ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const items = json.data?.boards?.[0]?.items_page?.items || [];
  const people = items
    .filter((it) => !GROUP_MATCH || (it.group?.title || "").toLowerCase().includes(GROUP_MATCH.toLowerCase()))
    .filter((it) => {
      // Skip anyone whose Status is not "Active". Inactive employees no
      // longer work here and shouldn't drive any headcount or replace
      // math. Missing status = treated as inactive (safer default).
      const st = (it.column_values || []).find((c) => c.id === STATUS_COLUMN_ID)?.text;
      return (st || "").trim() === STATUS_ACTIVE_LABEL;
    })
    .map((it) => {
      // Address concatenation excludes the Status column so its label
      // text ("Active") never leaks into placeOf() as a false match.
      const address = (it.column_values || [])
        .filter((c) => c.id !== STATUS_COLUMN_ID)
        .map((c) => c.text)
        .filter(Boolean)
        .join(" | ")
        .replace(/\s*\n\s*/g, " ");
      return { id: it.id, name: it.name, address, ...placeOf(address) };
    })
    .filter((p) => p.name && (p.town || p.district));

  setCached("roster", people);
  return people;
}

router.get("/roster", async (_req, res) => {
  try {
    res.json({ agents: await fetchRoster() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------ outages -------------------------------
 * BEL publishes a real HTML table at /PowerUpdates/ with districts, dates,
 * times, load centre, feeder and zone. That is authoritative and needs no
 * model, so it is the primary source.
 *
 * News scraping via Claude is an optional supplement: BEL's table carries
 * PLANNED work reliably but short-notice load shedding is often announced
 * only on their Facebook page, which disallows automated access. Set
 * GRID_NEWS_SUPPLEMENT=1 to fill that gap.
 * -------------------------------------------------------------------- */

function extractJSON(raw) {
  if (!raw) return null;
  const s = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const idxs = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  if (!idxs.length) return null;
  const first = Math.min(...idxs);
  const last = s.lastIndexOf(s[first] === "{" ? "}" : "]");
  if (last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

// Gemini with google_search grounding — uses the key that's already
// on prod. Free-tier friendly and well-indexed on Belize news outlets.
async function newsSupplement() {
  if (!process.env.GEMINI_API_KEY) return [];
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Search for Belize LOAD SHEDDING and ISP OUTAGE announcements published in the last 3 days as of ${today}.

Include:
  1. Rotating/emergency load shedding (ignore planned BEL maintenance — already covered).
  2. Reported outages from DigiBelize, Smart, Centaur Communications, Nexgen, or Beeline internet.

Sources: Love FM Belize, Breaking Belize News, Channel 5 Belize, 7 News Belize, Amandala, Greater Belize Media, and the ISPs' own posts when quoted by news outlets.

CRITICAL: Belize had near-identical CFE-linked power crises in 2024, June 2026 and July 2026. Check each article's publication date and discard anything older than 3 days.

Districts must be one of: Corozal, Orange Walk, Belize, Cayo, Stann Creek, Toledo.

Return ONLY minified JSON, no prose, no code fences:
{"grid_status":"normal|strained|emergency","grid_note":"<=20 words","outages":[{"id":"n1","districts":["Cayo"],"areas":["Belmopan","San Ignacio"],"district_wide":false,"start":"${today}T19:00:00-06:00","end":"${today}T21:30:00-06:00","type":"load_shedding|isp_outage","cause":"<=12 words","published":"${today}","source":"Love FM|DigiBelize","source_url":"https://..."}]}

If nothing is announced, return {"grid_status":"normal","grid_note":"","outages":[]}. Be terse.`;

  // gemini-3.1-pro-preview uses a thinking budget internally, so
  // maxOutputTokens must cover reasoning + JSON output.
  const model = process.env.GRID_NEWS_MODEL || "gemini-3.1-pro-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
    }),
  });
  if (!r.ok) return [];
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");
  const parsed = extractJSON(text);
  if (!parsed) return [];
  return { note: parsed.grid_note, status: parsed.grid_status, list: (parsed.outages || []).map((o, i) => {
    const districts = (o.districts || []).filter((d) => DISTRICTS.includes(d));
    const areaPlaces = (o.areas || []).map((a) => ({ raw: a, ...placeOf(a) }));
    for (const p of areaPlaces) if (p.district && !districts.includes(p.district)) districts.push(p.district);
    return { ...o, id: o.id || `news${i}`, districts, areaPlaces, excludes: [], excludePlaces: [] };
  }) };
}

// Split caches: BEL scrape is fast + deterministic (poll it aggressively
// so staffing sees new notices within ~60s of publication). News supplement
// is a slow, paid Gemini call — keep its 10-min cache so we don't burn
// budget on every poll. Manual entries have no cache; they merge live.
const BEL_TTL_MS = 60 * 1000;
const NEWS_TTL_MS = 10 * 60 * 1000;

router.get("/outages", async (req, res) => {
  try {
    const fresh = !!req.query.fresh;

    let bel = fresh ? null : getCached("bel", BEL_TTL_MS);
    let belRefreshed = false;
    if (!bel) {
      bel = await fetchPowerUpdates();
      setCached("bel", bel);
      belRefreshed = true;
    }

    let sup = null, supplemented = false;
    if (process.env.GRID_NEWS_SUPPLEMENT === "1") {
      sup = fresh ? null : getCached("news", NEWS_TTL_MS);
      if (!sup) {
        try {
          sup = await newsSupplement();
          setCached("news", sup);
        } catch { sup = null; /* BEL alone is still valid */ }
      }
      if (sup?.list?.length) supplemented = true;
    }

    let outages = bel;
    if (sup?.list?.length) {
      const seen = new Set(bel.map((o) => `${o.start.slice(0, 10)}|${o.districts.join()}`));
      const extra = sup.list.filter((o) => !seen.has(`${String(o.start).slice(0, 10)}|${o.districts.join()}`));
      outages = [...bel, ...extra];
    }

    const now = Date.now();
    outages = outages.filter((o) => !o.end || new Date(o.end).getTime() > now);

    let status = sup?.status || "normal";
    if (outages.some((o) => o.type === "load_shedding") && status === "normal") status = "strained";

    res.json({
      grid_status: status,
      grid_note: sup?.note || "",
      outages: [...outages, ...loadManual()],
      sources: { bel: bel.length, supplemented },
      checked: new Date().toISOString(),
    });

    // Slack heads-up on any newly-seen outage. Only runs when BEL was
    // actually re-fetched from the source (not when we serve the 60s
    // cache) so we don't burn Slack rate on identical cached payloads.
    if (belRefreshed) {
      fetchRoster()
        .then((roster) => notifyNewOutages(bel, roster))
        .catch((err) => console.error("Grid Watch notify:", err.message));
    }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* --------------------------- manual outages ---------------------------
 * ISP outages (Digi, Smart, etc.) are announced only on Facebook, which
 * blocks bots. Staffing logs them here so they show up in the same feed
 * as BEL outages and affect the same headcount calculations.
 * -------------------------------------------------------------------- */
router.get("/manual-outages", (_req, res) => {
  res.json({ outages: loadManual(), validSources: VALID_ISP_SOURCES, districts: DISTRICTS });
});

router.post("/manual-outages", express.json(), (req, res) => {
  try {
    const { source, districts = [], areas = [], start, end, cause, type } = req.body || {};
    if (!source) return res.status(400).json({ error: "source is required" });
    if (!start) return res.status(400).json({ error: "start time is required" });
    const validDistricts = districts.filter((d) => DISTRICTS.includes(d));

    const areaPlaces = (areas || []).filter(Boolean).map((a) => ({ raw: a, ...placeOf(a) }));
    // District can be derived from named areas too — union with what the
    // user picked so a "San Ignacio" area implicitly counts as Cayo.
    for (const p of areaPlaces) if (p.district && !validDistricts.includes(p.district)) validDistricts.push(p.district);
    // Empty districts array is allowed — the entry still saves as evidence
    // of a reported outage. It just won't cross-reference against staff
    // locations until a district is added later.

    const entry = {
      id: `man-${randomBytes(4).toString("hex")}`,
      districts: validDistricts,
      areas: areas || [],
      areaPlaces,
      district_wide: !areaPlaces.length,
      excludes: [],
      excludePlaces: [],
      start,
      end: end || null,
      type: type || "isp_outage",
      cause: (cause || "").slice(0, 200) || null,
      source,
      source_url: null,
      published: new Date().toISOString().slice(0, 10),
      manual: true,
      createdBy: req.user?.email || null,
      createdAt: new Date().toISOString(),
    };

    const list = loadManual();
    list.push(entry);
    saveManual(list);
    res.json({ entry });

    // Also ping Slack for manual entries so the team knows they were
    // logged. Runs after the response so the UI doesn't wait on it.
    fetchRoster()
      .then((roster) => {
        const notified = loadNotified();
        if (notified.has(entry.id)) return;
        return slackNotifyOutage(entry, roster).then(() => {
          notified.add(entry.id);
          saveNotified(notified);
        });
      })
      .catch((err) => console.error("Grid Watch notify:", err.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/manual-outages/:id", (req, res) => {
  const list = loadManual();
  const removed = list.find((o) => o.id === req.params.id);
  if (!removed) return res.status(404).json({ error: "not found" });
  // Delete on-disk attachment files along with the entry.
  for (const a of removed.attachments || []) {
    try { unlinkSync(path.join(ATTACH_DIR, a.storedName)); } catch (_) { /* already gone */ }
  }
  saveManual(list.filter((o) => o.id !== req.params.id));
  res.json({ ok: true });
});

/* --------------------------- attachments -----------------------------
 * Screenshots / evidence tied to a manual outage. Multipart POST accepts
 * up to 10 files at a time, appended to the entry's attachments array.
 * -------------------------------------------------------------------- */
router.post("/manual-outages/:id/attachments", upload.array("files", 10), (req, res) => {
  try {
    const list = loadManual();
    const entry = list.find((o) => o.id === req.params.id);
    if (!entry) {
      // Clean up files we just wrote — the entry doesn't exist to attach to.
      for (const f of req.files || []) { try { unlinkSync(f.path); } catch (_) {} }
      return res.status(404).json({ error: "outage not found" });
    }
    entry.attachments = entry.attachments || [];
    for (const f of req.files || []) {
      entry.attachments.push({
        id: `att-${randomBytes(4).toString("hex")}`,
        filename: f.originalname,
        storedName: f.filename,
        size: f.size,
        mime: f.mimetype,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.user?.email || null,
      });
    }
    saveManual(list);
    res.json({ attachments: entry.attachments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------- image → outage extraction ---------------------
 * Vision extraction — drop a screenshot of a Digi/BEL/Smart Facebook
 * post (or the BEL app), get back a pre-filled outage payload the form
 * can populate. Uses Gemini 3.1 Pro Preview with an inline image part.
 * -------------------------------------------------------------------- */
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.post("/extract-outage", extractUpload.single("image"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    if (!req.file) return res.status(400).json({ error: "image is required" });

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You're reading a screenshot of a Belize utility outage announcement — from BEL, DigiBelize, Smart, Centaur Communications, Nexgen, Beeline, or the BEL 24/7 app.

Extract the outage details. Return ONLY minified JSON — no prose, no code fences.

Schema:
{"source":"DigiBelize|Smart|Centaur Communications|Nexgen|Beeline|BEL|Other","type":"isp_outage|load_shedding|planned|other","districts":["Cayo"],"areas":["Belmopan","San Ignacio"],"start":"${today}T19:00:00-06:00","end":"${today}T21:30:00-06:00","cause":"<=20 words"}

CRITICAL — districts is required, never return an empty array:
- districts must be a subset of: Corozal, Orange Walk, Belize, Cayo, Stann Creek, Toledo
- If the notice explicitly names a district, use that.
- If it names towns/areas but not a district, MAP each town to its district and return them (Belmopan/San Ignacio/Benque = Cayo; Belize City/Ladyville/San Pedro = Belize; Dangriga/Placencia/Independence = Stann Creek; Punta Gorda = Toledo; Corozal Town/Sarteneja = Corozal; Orange Walk Town = Orange Walk).
- If it's country-wide/nationwide load shedding, return ALL SIX districts.
- If you truly cannot tell, return your single best guess based on the ISP's coverage area (Digi/Smart/BEL all serve nationwide → default to all six).

Other rules:
- If the source logo/name isn't visible, guess from context; use "Other" only as last resort
- All times are Belize time (-06:00). If a date isn't stated, use ${today}. If only a time is given, assume today.
- end may be null if not stated
- If it's a power outage from BEL, type is "planned" for scheduled maintenance or "load_shedding" for rotating cuts
- If it's an internet/ISP outage, type is "isp_outage"
- cause: brief reason (max 20 words), null if not stated
- If you can't tell it's an outage at all, return {"error":"not an outage announcement"}`;

    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: req.file.mimetype || "image/jpeg", data: req.file.buffer.toString("base64") } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 3000 },
    };
    const model = process.env.GRID_NEWS_MODEL || "gemini-3.1-pro-preview";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `Gemini returned ${r.status}: ${t.slice(0, 200)}` });
    }
    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n");
    const parsed = extractJSON(text);
    if (!parsed) return res.status(422).json({ error: "Could not parse Gemini response", raw: text.slice(0, 400) });
    if (parsed.error) return res.status(422).json({ error: parsed.error });

    // Backfill districts from named areas.
    const districts = (parsed.districts || []).filter((d) => DISTRICTS.includes(d));
    const areas = parsed.areas || [];
    for (const a of areas) {
      const p = placeOf(a);
      if (p.district && !districts.includes(p.district)) districts.push(p.district);
    }
    res.json({
      source: parsed.source || "Other",
      type: parsed.type || "isp_outage",
      districts,
      areas,
      start: parsed.start || null,
      end: parsed.end || null,
      cause: parsed.cause || "",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/attachments/:storedName", (req, res) => {
  // Prevent path traversal — only allow bare filenames.
  const name = path.basename(req.params.storedName);
  const p = path.join(ATTACH_DIR, name);
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(path.resolve(p));
});

// Test endpoint — verify the Slack webhook URL is reachable and looks
// right without waiting for a real BEL update. Uses the newest live or
// upcoming outage in the current cache, or a stub if none exist.
router.post("/notify-test", async (_req, res) => {
  try {
    if (!SLACK_URL) return res.status(503).json({ error: "SLACK_GRID_WATCH_URL not configured" });
    const roster = await fetchRoster().catch(() => []);
    const bel = getCached("bel", 60 * 60 * 1000) || [];
    const manual = loadManual();
    const now = Date.now();
    const candidates = [...bel, ...manual].filter((o) => !o.end || new Date(o.end).getTime() > now);
    const outage = candidates[0] || {
      id: "test-" + Date.now(),
      districts: ["Cayo"],
      areaPlaces: [{ raw: "Belmopan" }],
      district_wide: false,
      excludes: [],
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3600000).toISOString(),
      type: "isp_outage",
      source: "Test",
      cause: "Test notification — ignore",
    };
    await slackNotifyOutage(outage, roster);
    res.json({ ok: true, sent: outage.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/manual-outages/:id/attachments/:attId", (req, res) => {
  const list = loadManual();
  const entry = list.find((o) => o.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "not found" });
  const idx = (entry.attachments || []).findIndex((a) => a.id === req.params.attId);
  if (idx < 0) return res.status(404).json({ error: "attachment not found" });
  const [removed] = entry.attachments.splice(idx, 1);
  try { unlinkSync(path.join(ATTACH_DIR, removed.storedName)); } catch (_) {}
  saveManual(list);
  res.json({ ok: true });
});

/* ------------------------------ weather -------------------------------
 * Open-Meteo: free, no key, no attribution requirement. One batched call
 * covers every town the roster touches. NMS Belize publishes only to
 * Facebook, which disallows automated access, so warnings stay a link.
 * -------------------------------------------------------------------- */
router.get("/weather", async (_req, res) => {
  try {
    const cached = getCached("weather", 30 * 60 * 1000);
    if (cached) return res.json({ ...cached, cached: true });

    const agents = await fetchRoster().catch(() => []);
    const towns = [...new Set(agents.map((a) => a.town).filter((t) => t && TOWN_COORDS[t]))];
    if (!towns.length) return res.json({ towns: [] });

    const lat = towns.map((t) => TOWN_COORDS[t][0]).join(",");
    const lon = towns.map((t) => TOWN_COORDS[t][1]).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,precipitation,wind_speed_10m,weather_code` +
      `&daily=precipitation_sum,wind_speed_10m_max,weather_code` +
      `&timezone=America%2FBelize&forecast_days=3&wind_speed_unit=kmh`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`open-meteo returned ${r.status}`);
    const raw = await r.json();
    const list = Array.isArray(raw) ? raw : [raw];

    // WMO codes 95/96/99 = thunderstorm. Those plus heavy rain or high wind
    // are what actually knock a home worker offline.
    const out = list.map((d, i) => {
      const code = d.current?.weather_code ?? 0;
      const rain = d.daily?.precipitation_sum?.[0] ?? 0;
      const gust = d.daily?.wind_speed_10m_max?.[0] ?? 0;
      const severe = code >= 95 || rain >= 50 || gust >= 60;
      const watch = !severe && (code >= 80 || rain >= 20 || gust >= 40);
      return {
        town: towns[i],
        staff: agents.filter((a) => a.town === towns[i]).length,
        temp: d.current?.temperature_2m ?? null,
        wind: d.current?.wind_speed_10m ?? null,
        code, rainToday: rain, gustToday: gust,
        level: severe ? "severe" : watch ? "watch" : "ok",
      };
    }).sort((a, b) => b.staff - a.staff);

    const payload = { towns: out, checked: new Date().toISOString() };
    setCached("weather", payload);
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------ sources -------------------------------
 * Facebook disallows automated access (robots), and none of these pages
 * are ones you own, so there is no API path. They render as link tiles —
 * one tap for whoever is on duty.
 * -------------------------------------------------------------------- */
router.get("/sources", (_req, res) => {
  res.json({
    power: [
      { name: "BEL Power Updates", url: "https://www.bel.com.bz/PowerUpdates/", live: true },
      { name: "BEL Facebook", url: "https://www.facebook.com/BelizeElectricityLimited" },
      { name: "BEL 24/7 app", url: "https://play.google.com/store/apps/details?id=bz.com.bel247" },
    ],
    weather: [
      { name: "Belize Weather", url: "https://www.facebook.com/BelizeWeather" },
      { name: "NMS Belize", url: "https://www.facebook.com/nms.belize" },
    ],
    isp: [
      { name: "DigiBelize", url: "https://www.facebook.com/DigiBz" },
      { name: "Smart", url: "https://www.facebook.com/smartbze" },
      { name: "Centaur Communications", url: "https://www.facebook.com/centaurcommunications" },
      { name: "Nexgen", url: "https://www.facebook.com/nexgenbelize" },
      { name: "Beeline", url: "https://www.facebook.com/BeelineInternetBelize" },
    ],
  });
});

export default router;

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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { DISTRICTS, placeOf, TOWN_COORDS, norm } from "./client/src/lib/belize-places.mjs";
import { fetchPowerUpdates } from "./bel-scraper.mjs";

const MANUAL_STORE = "./grid-manual-outages.json";
const VALID_ISP_SOURCES = ["DigiBelize", "Smart", "Centaur Communications", "Nexgen", "Beeline", "BEL", "Other"];

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
    .map((it) => {
      const address = (it.column_values || [])
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

async function newsSupplement() {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Search for Belize LOAD SHEDDING and ISP OUTAGE announcements published in the last 3 days as of ${today}.

Include:
  1. Rotating/emergency load shedding (ignore planned BEL maintenance — already covered).
  2. Reported outages from DigiBelize, Smart, Centaur Communications, Nexgen, or Beeline internet.

Sources: Love FM Belize, Breaking Belize News, Channel 5 Belize, 7 News Belize, Amandala, Greater Belize Media, and the ISPs' own posts when quoted by news outlets.

CRITICAL: Belize had near-identical CFE-linked power crises in 2024, June 2026 and July 2026. Check each article's publication date and discard anything older than 3 days.

Return ONLY minified JSON, no prose:
{"grid_status":"normal|strained|emergency","grid_note":"<=20 words","outages":[{"id":"n1","districts":["Cayo"],"areas":["Belmopan","San Ignacio"],"district_wide":false,"start":"${today}T19:00:00-06:00","end":"${today}T21:30:00-06:00","type":"load_shedding|isp_outage","cause":"<=12 words","published":"${today}","source":"Love FM|DigiBelize","source_url":"https://..."}]}

If nothing is announced, return an empty outages array. Be terse.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!r.ok) return [];
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const parsed = extractJSON(text);
  if (!parsed) return [];
  return { note: parsed.grid_note, status: parsed.grid_status, list: (parsed.outages || []).map((o, i) => {
    const districts = (o.districts || []).filter((d) => DISTRICTS.includes(d));
    const areaPlaces = (o.areas || []).map((a) => ({ raw: a, ...placeOf(a) }));
    for (const p of areaPlaces) if (p.district && !districts.includes(p.district)) districts.push(p.district);
    return { ...o, id: o.id || `news${i}`, districts, areaPlaces, excludes: [], excludePlaces: [] };
  }) };
}

router.get("/outages", async (req, res) => {
  try {
    if (!req.query.fresh) {
      const cached = getCached("outages", 10 * 60 * 1000);
      if (cached) {
        // Manual entries are cheap to reload every call and change more
        // often than BEL — merge them in fresh so a new manual outage
        // shows up without waiting 10 min for the BEL cache to expire.
        return res.json({ ...cached, outages: [...cached.outages, ...loadManual()], cached: true });
      }
    }

    const bel = await fetchPowerUpdates();
    let outages = bel;
    let status = "normal", note = "", supplemented = false;

    if (process.env.GRID_NEWS_SUPPLEMENT === "1") {
      try {
        const sup = await newsSupplement();
        if (sup?.list?.length) {
          // Drop news items that duplicate a BEL row (same day + district)
          const seen = new Set(bel.map((o) => `${o.start.slice(0, 10)}|${o.districts.join()}`));
          const extra = sup.list.filter((o) => !seen.has(`${String(o.start).slice(0, 10)}|${o.districts.join()}`));
          outages = [...bel, ...extra];
          supplemented = true;
        }
        if (sup?.status) status = sup.status;
        if (sup?.note) note = sup.note;
      } catch { /* BEL alone is still a valid answer */ }
    }

    const now = Date.now();
    outages = outages.filter((o) => !o.end || new Date(o.end).getTime() > now);
    if (outages.some((o) => o.type === "load_shedding")) status = status === "normal" ? "strained" : status;

    const payload = {
      grid_status: status,
      grid_note: note,
      outages,
      sources: { bel: bel.length, supplemented },
      checked: new Date().toISOString(),
    };
    setCached("outages", payload);
    // Merge manual entries after caching so cache expiry doesn't affect
    // how quickly a fresh manual entry appears.
    res.json({ ...payload, outages: [...outages, ...loadManual()] });
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
    if (!validDistricts.length) return res.status(400).json({ error: "at least one valid district is required" });

    const areaPlaces = (areas || []).filter(Boolean).map((a) => ({ raw: a, ...placeOf(a) }));
    // District can be derived from named areas too — union with what the
    // user picked so a "San Ignacio" area implicitly counts as Cayo.
    for (const p of areaPlaces) if (p.district && !validDistricts.includes(p.district)) validDistricts.push(p.district);

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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/manual-outages/:id", (req, res) => {
  const list = loadManual();
  const next = list.filter((o) => o.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: "not found" });
  saveManual(next);
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

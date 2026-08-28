import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import {
  RefreshCw, Settings, AlertTriangle, Zap, Users, Clock, ExternalLink,
  Activity, Upload, Download, FileSpreadsheet, Radio, Map as MapIcon,
  CalendarDays, X, Moon, Eye, CheckCircle2, Plus, Trash2,
} from "lucide-react";

/* ==================================================================== */
/*  Belize Grid Watch — town-first outage impact on scheduled staff      */
/* ==================================================================== */

import { DISTRICTS, placeOf, nameKeys, norm, TOWN_COORDS } from "../lib/belize-places.mjs";
import { parseSchedulePdf } from "../lib/parse-schedule-pdf.mjs";

const API = import.meta.env?.VITE_GRID_API ?? "/api/grid";
const BOARD_URL = import.meta.env?.VITE_GRID_BOARD_URL
  ?? "https://answeringlegal-unit.monday.com/boards/18415794851";

// The WFM export tags Belize staff with [C]. Everyone else is US/remote and
// must never be flagged for a Belize outage, so this is the default scope.
const BELIZE_SITE = "C";

const DISTRICT_META = {
  Corozal: { path: "M190,55 L232,20 L250,10 L262,45 L245,70 L240,100 L258,130 L205,132 L180,105 Z", label: [222, 78] },
  "Orange Walk": { path: "M38,129 L88,129 L140,95 L190,55 L180,105 L205,132 L208,175 L150,190 L100,196 L38,196 Z", label: [122, 152] },
  Belize: { path: "M208,175 L258,130 L268,160 L262,190 L278,225 L272,255 L258,285 L200,282 L175,240 L185,200 Z", label: [228, 228], extra: ["M360,78 L367,87 L330,181 L318,193 L322,172 L352,85 Z", "M318,198 L324,201 L316,216 L312,212 Z"] },
  Cayo: { path: "M38,196 L100,196 L150,190 L208,175 L185,200 L175,240 L200,282 L190,330 L150,360 L100,370 L38,370 Z", label: [112, 272] },
  "Stann Creek": { path: "M200,282 L258,285 L268,320 L270,360 L250,400 L240,440 L232,470 L195,455 L175,410 L190,330 Z", label: [225, 372] },
  Toledo: { path: "M38,370 L100,370 L150,360 L190,330 L175,410 L195,455 L232,470 L210,505 L175,535 L140,558 L108,590 L98,612 L38,600 Z", label: [118, 480] },
};

const C = {
  ink: "#07131F", panel: "#0E2038", panelHi: "#16304F", line: "#22405F",
  gold: "#C9A227", goldSoft: "#E3C766", mint: "#4FBF9F", amber: "#E8A33D",
  red: "#D8503F", text: "#E8F0F8", dim: "#8AA3BF",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/* ------------------------------ helpers ------------------------------- */
const parseTs = (s) => { if (!s) return null; const d = s instanceof Date ? s : new Date(s); return isNaN(d) ? null : d; };
const fmtTime = (d) => (d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Belize" }) : "—");
// ET display for schedule shifts — the WFM PDF is stamped in Eastern time
// and staffing thinks in that zone, so shift rows read in ET even though
// everything else on the board (outages, weather) is Belize.
const fmtTimeET = (d) => (d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "—");
const fmtDay = (d) => (d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Belize" }) : "");
const fmtDayET = (d) => (d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) : "");
const hrs = (ms) => Math.round((ms / 3600000) * 10) / 10;

function windowLabel(o) {
  const s = parseTs(o.start), e = parseTs(o.end);
  return s ? `${fmtDay(s)} · ${fmtTime(s)}–${e ? fmtTime(e) : "?"} BZ` : "Time not stated";
}
function statusOf(o, now = new Date()) {
  const s = parseTs(o.start), e = parseTs(o.end);
  if (!s) return "upcoming";
  if (e && now > e) return "past";
  return now >= s && (!e || now <= e) ? "active" : "upcoming";
}
const hoursUntil = (o, now = new Date()) => { const s = parseTs(o.start); return s ? (s - now) / 3600000 : 999; };
const overlapMs = (aS, aE, bS, bE) => (!aS || !aE || !bS || !bE ? 0 : Math.max(0, Math.min(aE, bE) - Math.max(aS, bS)));



/* ------------------------------ data hooks ---------------------------- */
// Auto-poll cadence — server caches BEL for 60s, so this is a cheap
// no-op most of the time and just rides the cache. When BEL publishes a
// new notice, staffing sees it within 60-120s of the site updating.
const OUTAGE_POLL_MS = 60000;

function useOutages() {
  const [outages, setOutages] = useState([]);
  const [grid, setGrid] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState(null);

  const load = useCallback(async (fresh) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/outages${fresh ? "?fresh=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Outage lookup failed (${res.status})`);
      setOutages((data.outages || []).filter((o) => statusOf(o) !== "past"));
      setGrid({ status: data.grid_status || "normal", note: data.grid_note || "" });
      setChecked(data.checked ? new Date(data.checked) : new Date());
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(false), OUTAGE_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return { outages, grid, loading, error, checked, reload: load };
}

function useRoster() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/roster`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Roster fetch failed (${res.status})`);
      setAgents(data.agents || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { agents, loading, error, reload: load };
}

function useWeather() {
  const [towns, setTowns] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${API}/weather`).then((r) => r.json())
      .then((d) => { if (live) (d.error ? setError(d.error) : setTowns(d.towns || [])); })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, []);
  return { towns, error };
}

function useSources() {
  const [src, setSrc] = useState(null);
  useEffect(() => { fetch(`${API}/sources`).then((r) => r.json()).then(setSrc).catch(() => {}); }, []);
  return src;
}

function useTick(ms = 60000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}

/* -------------------------- schedule ingestion ------------------------ */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function parseDateCell(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 60000) return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(new Date().getFullYear());
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function parseTimeCell(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v.getHours() * 60 + v.getMinutes();
  if (typeof v === "number") {
    if (v >= 0 && v < 1.0001) return Math.round(v * 1440);
    if (v % 1 > 0) return Math.round((v % 1) * 1440);
    if (v >= 0 && v <= 24) return Math.round(v * 60);
  }
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?/) || s.match(/^(\d{1,2})()\s*(am|pm)/) || s.match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h > 24 ? null : h * 60 + mi;
}
const splitShiftString = (v) => {
  const p = String(v || "").trim().split(/\s*(?:-|–|—|to|until|thru)\s*/i).filter(Boolean);
  return p.length >= 2 ? [p[0], p[1]] : [null, null];
};
const HEADER_HINTS = {
  agent: ["agent", "name", "employee", "staff", "rep", "person", "full name"],
  date: ["date", "day", "shift date", "work date"],
  start: ["start", "shift start", "time in", "clock in", "begin", "in", "from"],
  end: ["end", "shift end", "time out", "clock out", "finish", "out", "to"],
  shift: ["shift", "hours", "schedule", "shift time"],
  site: ["site", "team", "cohort", "office", "group"],
  place: ["district", "location", "town", "village", "city", "address", "area"],
  role: ["role", "position", "title", "queue", "skill", "department"],
};
function autoMap(headers) {
  const map = {}, used = new Set();
  for (const [field, hints] of Object.entries(HEADER_HINTS)) {
    let best = null, bestScore = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const n = norm(h);
      if (!n) return;
      for (const hint of hints) {
        const score = n === hint ? 100 : n.startsWith(hint) || n.endsWith(hint) ? 70 : n.includes(hint) ? 45 : 0;
        if (score > bestScore) { bestScore = score; best = i; }
      }
    });
    if (best != null && bestScore >= 45) { map[field] = best; used.add(best); }
  }
  return map;
}
function readWorkbook(file) {
  if (/\.pdf$/i.test(file.name)) return parseSchedulePdf(file);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Could not read that file."));
    r.onload = (e) => {
      try {
        if (/\.csv$/i.test(file.name)) resolve(Papa.parse(String(e.target.result), { skipEmptyLines: true }).data);
        else {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
          resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, blankrows: false, defval: "" }));
        }
      } catch { reject(new Error("That file could not be parsed. Try CSV, .xlsx, or the WFM PDF export.")); }
    };
    if (/\.csv$/i.test(file.name)) r.readAsText(file); else r.readAsArrayBuffer(file);
  });
}
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i] || [];
    if (r.filter((c) => String(c || "").trim()).length < 2) continue;
    const m = autoMap(r);
    if (m.agent != null && (m.date != null || m.shift != null || m.start != null)) return i;
  }
  return 0;
}
// The WFM PDF stamps shifts in America/New_York — EDT (-04:00) most of
// the year, EST (-05:00) Nov–Mar. Belize is UTC-6 year-round. Parsing
// with the wrong offset makes every shift 1-2 hours off vs. BEL notices,
// which throws off overlap detection AND the display (since fmtTime
// converts to Belize). Compute the correct offset per shift date.
function easternOffsetFor(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (m < 3 || m > 11) return "-05:00";
  if (m > 3 && m < 11) return "-04:00";
  const firstOfMonth = new Date(Date.UTC(y, m - 1, 1));
  const firstSunday = 1 + ((7 - firstOfMonth.getUTCDay()) % 7);
  if (m === 3) return d >= firstSunday + 7 ? "-04:00" : "-05:00";
  return d < firstSunday ? "-04:00" : "-05:00";
}

function buildShifts(rows, headerRow, map) {
  const out = [], problems = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const agent = String(r[map.agent] ?? "").trim();
    if (!agent) continue;
    let sRaw = map.start != null ? r[map.start] : null;
    let eRaw = map.end != null ? r[map.end] : null;
    if ((sRaw == null || sRaw === "") && map.shift != null) [sRaw, eRaw] = splitShiftString(r[map.shift]);
    const date = map.date != null ? parseDateCell(r[map.date]) : null;
    const sMin = parseTimeCell(sRaw), eMin = parseTimeCell(eRaw);
    if (!date || sMin == null || eMin == null) {
      problems.push({ row: i + 1, agent, reason: !date ? "No readable date" : "No readable shift time" });
      continue;
    }
    const off = easternOffsetFor(date);
    const start = new Date(`${date}T${String(Math.floor(sMin / 60) % 24).padStart(2, "0")}:${String(sMin % 60).padStart(2, "0")}:00${off}`);
    let end = new Date(`${date}T${String(Math.floor(eMin / 60) % 24).padStart(2, "0")}:${String(eMin % 60).padStart(2, "0")}:00${off}`);
    if (end <= start) end = new Date(end.getTime() + 86400000);
    out.push({
      key: String(i), agent, keys: nameKeys(agent), date, start, end,
      site: map.site != null ? String(r[map.site] ?? "").trim() : "",
      placeHint: map.place != null ? placeOf(r[map.place]) : null,
      role: map.role != null ? String(r[map.role] ?? "").trim() : "",
    });
  }
  return { shifts: out, problems };
}

/* --------------------------- impact analysis -------------------------- */
// Two tiers, deliberately separated:
//   confirmed — the notice names this person's town  -> act on it
//   possible  — right district, town not named       -> monitor only
// A district-wide notice promotes everyone in it to confirmed.
function analyze(shifts, outages, agents, siteFilter) {
  const lookup = new Map();
  agents.forEach((a) => nameKeys(a.name).forEach((k) => { if (!lookup.has(k)) lookup.set(k, a); }));

  const resolved = shifts
    .filter((s) => (siteFilter === "all" ? true : s.site === siteFilter))
    .map((s) => {
      const m = s.keys.map((k) => lookup.get(k)).find(Boolean);
      const town = s.placeHint?.town || m?.town || null;
      const district = s.placeHint?.district || m?.district || null;
      return { ...s, town, district, address: m?.address || "" };
    });

  const unknown = resolved.filter((s) => !s.district && !s.town);
  const placed = resolved.filter((s) => s.district || s.town);

  const groups = outages.map((o) => {
    const oS = parseTs(o.start), oE = parseTs(o.end);
    const areaNames = (o.areaPlaces || []).map((p) => norm(p.raw)).filter((x) => x.length >= 4);
    const exNames = (o.excludePlaces || o.excludes || []).map((p) => norm(p.raw ?? p)).filter((x) => x.length >= 4);
    const wide = o.district_wide || areaNames.length === 0;

    const rows = placed
      .filter((s) => s.district && o.districts.includes(s.district) && overlapMs(s.start, s.end, oS, oE) > 0)
      .map((s) => {
        const t = norm(s.town || "");
        // town must be named by the notice AND the district must already agree,
        // which stops "Bladen Street, Belmopan" matching Bladen village in Toledo
        // BEL writes "entire Toledo District except Monkey River, ..." — an
        // exemption must beat a district-wide flag or we flag people who
        // explicitly keep power.
        const exempt = t.length >= 4 && exNames.some((a) => a.includes(t) || t.includes(a));
        const named = t.length >= 4 && areaNames.some((a) => a.includes(t) || t.includes(a));
        const lost = overlapMs(s.start, s.end, oS, oE);
        return {
          ...s, lost, pct: Math.round((lost / (s.end - s.start)) * 100),
          from: new Date(Math.max(s.start, oS)), to: new Date(Math.min(s.end, oE)),
          tier: exempt ? "exempt" : wide || named ? "confirmed" : "possible",
        };
      })
      .sort((a, b) => b.pct - a.pct || a.start - b.start);

    const confirmed = rows.filter((r) => r.tier === "confirmed");
    const possible = rows.filter((r) => r.tier === "possible");
    const exempt = rows.filter((r) => r.tier === "exempt");
    return {
      outage: o, wide, confirmed, possible, exempt,
      headcount: new Set(confirmed.map((r) => r.agent)).size,
      watching: new Set(possible.map((r) => r.agent)).size,
      lostMs: confirmed.reduce((t, r) => t + r.lost, 0),
    };
  })
    .filter((g) => g.confirmed.length || g.possible.length || g.exempt.length)
    .sort((a, b) => (parseTs(a.outage.start) || 0) - (parseTs(b.outage.start) || 0));

  return { groups, unknown, placedCount: placed.length, totalCount: resolved.length };
}

/* -------------------------------- UI bits ----------------------------- */
function Pill({ tone, children }) {
  const m = {
    active: { bg: "rgba(216,80,63,0.15)", fg: C.red, bd: "rgba(216,80,63,0.45)" },
    upcoming: { bg: "rgba(232,163,61,0.14)", fg: C.amber, bd: "rgba(232,163,61,0.4)" },
    clear: { bg: "rgba(79,191,159,0.13)", fg: C.mint, bd: "rgba(79,191,159,0.38)" },
    gold: { bg: "rgba(201,162,39,0.14)", fg: C.goldSoft, bd: "rgba(201,162,39,0.4)" },
    quiet: { bg: "rgba(138,163,191,0.1)", fg: C.dim, bd: "rgba(138,163,191,0.3)" },
  }[tone] || { bg: "rgba(79,191,159,0.13)", fg: C.mint, bd: "rgba(79,191,159,0.38)" };
  return <span style={{ background: m.bg, color: m.fg, borderColor: m.bd, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded border whitespace-nowrap">{children}</span>;
}
function Panel({ title, right, children, className = "" }) {
  return (
    <div style={{ background: C.panel, borderColor: C.line }} className={`rounded-xl border p-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-3 gap-2">
          <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
function Stat({ icon: Icon, label, value, tone, sub }) {
  return (
    <div style={{ background: C.panel, borderColor: C.line }} className="p-3 rounded-xl border">
      <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest flex items-center gap-1.5 mb-2"><Icon size={11} /> {label}</div>
      <div style={{ color: tone, fontFamily: MONO }} className="text-2xl font-bold capitalize leading-none">{value}</div>
      {sub && <div style={{ color: C.dim }} className="text-[11px] mt-1.5 leading-snug">{sub}</div>}
    </div>
  );
}

// Approximate lat/lon -> SVG viewBox transform. The map is stylized, so
// this isn't projection-accurate, but towns land inside (or very near) the
// correct district, which is all the visual needs to show.
const BBOX = { minLon: -89.30, maxLon: -87.70, minLat: 15.90, maxLat: 18.50 };
const svgFromLatLon = (lat, lon) => [
  ((lon - BBOX.minLon) / (BBOX.maxLon - BBOX.minLon)) * 330 + 38,
  ((BBOX.maxLat - lat) / (BBOX.maxLat - BBOX.minLat)) * 602 + 10,
];

function BelizeMap({ byDistrict, selected, onSelect, agents }) {
  // Town-forward layout: districts recede to muted backdrop, towns
  // dominate. Outage state still colors the district hatch/border for
  // context, but the staffing story is told at the town level.
  const fill = (d) => { const s = byDistrict[d]?.worst; return s === "active" ? "url(#hatchRed)" : s === "upcoming" ? "rgba(232,163,61,0.06)" : "rgba(255,255,255,0.02)"; };
  const stroke = (d) => { const s = byDistrict[d]?.worst; return s === "active" ? "rgba(216,80,63,0.55)" : s === "upcoming" ? "rgba(232,163,61,0.45)" : "rgba(34,64,95,0.35)"; };
  const isAffected = (d) => byDistrict[d]?.worst === "active" || byDistrict[d]?.worst === "upcoming";

  // Cluster agents by town (one dot per town, sized by headcount).
  // Non-coord towns fall through silently — they still count in the
  // per-district total shown under the district label. Labels use a
  // simple collision-avoidance pass: sort by y, and if two labels are
  // within a threshold, push the later one down.
  const townClusters = useMemo(() => {
    const m = new Map();
    for (const a of agents || []) {
      const key = a.town && TOWN_COORDS[a.town] ? a.town : null;
      if (!key) continue;
      if (!m.has(key)) m.set(key, { count: 0, district: a.district });
      m.get(key).count++;
    }
    const raw = [...m.entries()].map(([town, v]) => {
      const [lat, lon] = TOWN_COORDS[town];
      const [x, y] = svgFromLatLon(lat, lon);
      return { town, x, y, count: v.count, district: v.district };
    });
    // Collision pass — group by rough x-bucket, then push labels down
    // if the previous one in the bucket is too close vertically.
    raw.sort((a, b) => a.y - b.y);
    const lastY = new Map();
    for (const c of raw) {
      const bucket = Math.round(c.x / 40);
      const prev = lastY.get(bucket) ?? -999;
      const r = 5 + Math.min(c.count, 8);
      const desired = c.y + r + 14;
      c.labelY = desired < prev + 14 ? prev + 14 : desired;
      lastY.set(bucket, c.labelY);
    }
    return raw;
  }, [agents]);

  return (
    <svg viewBox="0 0 400 640" className="w-full h-full" role="img" aria-label="Belize districts and staff locations">
      <defs>
        <pattern id="hatchRed" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="7" height="7" fill="#3A1620" />
          <line x1="0" y1="0" x2="0" y2="7" stroke={C.red} strokeWidth="2.5" opacity="0.75" />
        </pattern>
      </defs>
      {/* Districts as backdrop — muted fills, thin borders. District
          names sit at the top-left corner of each shape so they don't
          overlap town markers. */}
      {DISTRICTS.map((d) => {
        const meta = DISTRICT_META[d], info = byDistrict[d] || {}, sel = selected === d;
        return (
          <g key={d} onClick={() => onSelect(sel ? null : d)} style={{ cursor: "pointer" }} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(sel ? null : d)}>
            <path d={meta.path} fill={fill(d)} stroke={sel ? C.gold : stroke(d)} strokeWidth={sel ? 2.6 : 0.9} strokeLinejoin="round" />
            {(meta.extra || []).map((p, i) => <path key={i} d={p} fill={fill(d)} stroke={sel ? C.gold : stroke(d)} strokeWidth="0.8" />)}
          </g>
        );
      })}
      {/* Town markers first, then labels — separating groups so all dots
          render below all labels. Only affected-district towns get a
          visible label so unaffected areas stay quiet; hover title still
          works for the rest. */}
      {townClusters.map(({ town, x, y, count, district }) => {
        const affected = district && isAffected(district);
        const active = district && byDistrict[district]?.worst === "active";
        const r = 5 + Math.min(count, 8);
        return (
          <g key={`m-${town}`}>
            <title>{town} · {count} staff{affected ? ` · in outage area (${district})` : ""}</title>
            {affected && (
              <circle cx={x} cy={y} r={r + 4} fill="none" stroke={active ? C.red : C.amber} strokeWidth="1.8" strokeOpacity="0.75">
                {active && <animate attributeName="stroke-opacity" values="0.9;0.35;0.9" dur="1.6s" repeatCount="indefinite" />}
              </circle>
            )}
            <circle cx={x} cy={y} r={r} fill={C.mint} fillOpacity={0.95} stroke={C.ink} strokeWidth="1.5" />
            {count > 1 && (
              <text x={x} y={y + 4.5} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 12, fontWeight: 800 }} fill={C.ink}>
                {count}
              </text>
            )}
          </g>
        );
      })}
      {/* Second pass: labels for affected-district towns only, using the
          collision-adjusted labelY so nearby names don't overlap. */}
      {townClusters.filter((c) => c.district && isAffected(c.district)).map(({ town, x, labelY, district }) => {
        const active = byDistrict[district]?.worst === "active";
        return (
          <text
            key={`t-${town}`}
            x={x} y={labelY}
            textAnchor="middle"
            style={{ fontFamily: SANS, fontSize: 13, fontWeight: 700, textTransform: "capitalize", paintOrder: "stroke" }}
            stroke={C.ink} strokeWidth="4"
            fill={active ? C.red : C.amber}
          >
            {town}
          </text>
        );
      })}
      {/* District name pinned at the top of each shape — small and
          muted so it labels the region without competing with towns. */}
      {DISTRICTS.map((d) => {
        const meta = DISTRICT_META[d], info = byDistrict[d] || {};
        return (
          <text key={`d-${d}`} x={meta.label[0]} y={meta.label[1] - 40} textAnchor="middle" fill={info.worst ? "rgba(232,240,248,0.5)" : "rgba(138,163,191,0.4)"} style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", pointerEvents: "none" }}>{d.toUpperCase()}</text>
        );
      })}
    </svg>
  );
}

/* -------------------------- district grid ----------------------------- */
// Replaces the stylized map. Six cards, one per district — each shows
// status, staff count, and the names to replace. Click to filter the
// notices feed. This is what staffing actually needs to see: who lives
// where, who's affected, and who to call.
function DistrictGrid({ byDistrict, agents, outages, shifts, selected, onSelect }) {
  const now = new Date();

  // Precompute per-district: status, town breakdown, replace/monitor
  // staff (from homeAffected), and outage count.
  const cards = useMemo(() => {
    const homeGroups = computeHomeAffected(agents, outages, { shifts, now });
    // Flatten by district — a staffer can be flagged by multiple
    // outages; keep them distinct-by-name per district and prefer the
    // most-actionable tier they have (confirmed > monitoring > exempt).
    const perDistrict = new Map();
    for (const d of DISTRICTS) perDistrict.set(d, new Map());
    const rank = (t) => (t === "confirmed" ? 3 : t === "monitoring" ? 2 : 1);
    for (const g of homeGroups) {
      for (const r of g.rows) {
        // Add each affected agent to THEIR OWN district card only. The
        // outage might span 4 districts, but the agent lives in one of
        // them — flagging them under all four inflates every card.
        const d = r.agent.district;
        if (!perDistrict.has(d)) continue;
        const bucket = perDistrict.get(d);
        const prev = bucket.get(r.agent.name);
        if (!prev || rank(r.tier) > rank(prev.tier)) bucket.set(r.agent.name, r);
      }
    }

    return DISTRICTS.map((d) => {
      const info = byDistrict[d] || {};
      const inDistrict = agents.filter((a) => a.district === d);
      const townCounts = inDistrict.reduce((m, a) => {
        if (!a.town) return m;
        m.set(a.town, (m.get(a.town) || 0) + 1);
        return m;
      }, new Map());
      const towns = [...townCounts.entries()].sort((a, b) => b[1] - a[1]);
      const affected = [...perDistrict.get(d).values()]
        .sort((a, b) => (a.tier === b.tier ? a.agent.name.localeCompare(b.agent.name) : a.tier === "confirmed" ? -1 : b.tier === "confirmed" ? 1 : 0));
      const replaceCount = affected.filter((r) => r.tier === "confirmed").length;
      const monitorCount = affected.filter((r) => r.tier === "monitoring").length;
      const notices = outages.filter((o) => o.districts.includes(d)).length;
      return { d, info, staff: inDistrict.length, towns, affected, replaceCount, monitorCount, notices };
    });
  }, [byDistrict, agents, outages]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {cards.map(({ d, info, staff, towns, affected, replaceCount, monitorCount, notices }) => {
        const sel = selected === d;
        const worst = info.worst;
        const tone = worst === "active" ? C.red : worst === "upcoming" ? C.amber : C.dim;
        const cardBg = worst === "active" ? "rgba(216,80,63,0.06)" : worst === "upcoming" ? "rgba(232,163,61,0.05)" : C.panel;
        const cardBorder = sel ? C.gold : worst === "active" ? "rgba(216,80,63,0.4)" : worst === "upcoming" ? "rgba(232,163,61,0.35)" : C.line;
        return (
          <button
            key={d}
            onClick={() => onSelect(sel ? null : d)}
            style={{ background: cardBg, borderColor: cardBorder }}
            className="text-left rounded-xl border p-3.5 transition-colors hover:opacity-95"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <div style={{ color: C.text, fontFamily: SANS }} className="text-sm font-bold tracking-wide uppercase truncate">{d}</div>
                <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mt-0.5">
                  {staff} staff{towns.length ? ` · ${towns.length} town${towns.length !== 1 ? "s" : ""}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span style={{ background: tone }} className={`w-2 h-2 rounded-full ${worst === "active" ? "animate-pulse" : ""}`} />
                <span style={{ color: tone, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">
                  {worst === "active" ? "Dark" : worst === "upcoming" ? "Upcoming" : "Clear"}
                </span>
              </div>
            </div>

            {/* Headline counter — the "so what" for this district. */}
            <div className="flex items-baseline gap-3 mb-2.5">
              <div style={{ color: replaceCount ? C.red : monitorCount ? C.amber : C.dim, fontFamily: MONO }} className="text-3xl font-bold leading-none">
                {replaceCount || monitorCount || staff}
              </div>
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest leading-tight">
                {replaceCount ? "to replace" : monitorCount ? "to monitor" : staff ? "live here" : "no staff"}
              </div>
            </div>

            {/* Named affected staff — replace tier first, then monitor. */}
            {affected.length > 0 ? (
              <div style={{ borderColor: "rgba(255,255,255,0.05)" }} className="border-t pt-2 space-y-0.5">
                {affected.slice(0, 6).map(({ agent, tier }) => {
                  const rowTone = tier === "confirmed" ? C.red : tier === "exempt" ? C.dim : C.amber;
                  return (
                    <div key={agent.id} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span style={{ background: rowTone }} className="w-1.5 h-1.5 rounded-full shrink-0" />
                        <span style={{ color: C.text }} className="text-[11px] truncate">{agent.name}</span>
                      </div>
                      <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] capitalize shrink-0 truncate max-w-[80px]">{agent.town || "—"}</span>
                    </div>
                  );
                })}
                {affected.length > 6 && (
                  <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] pt-0.5">+ {affected.length - 6} more</div>
                )}
              </div>
            ) : towns.length > 0 ? (
              <div style={{ borderColor: "rgba(255,255,255,0.05)" }} className="border-t pt-2">
                <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] leading-relaxed capitalize">
                  {towns.slice(0, 4).map(([t, n]) => `${t} (${n})`).join(" · ")}
                  {towns.length > 4 && ` +${towns.length - 4}`}
                </div>
              </div>
            ) : null}

            {notices > 0 && (
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mt-2.5 flex items-center gap-1">
                <Zap size={9} /> {notices} notice{notices !== 1 ? "s" : ""}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------- town watchlist --------------------------- */
function Watchlist({ agents, outages }) {
  const now = new Date();
  const counts = useMemo(() => {
    const m = new Map();
    agents.forEach((a) => { if (a.town) m.set(a.town, (m.get(a.town) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [agents]);

  const live = outages.filter((o) => statusOf(o, now) !== "past");
  const flagFor = (town) => {
    const t = norm(town);
    for (const o of live) {
      const named = (o.areaPlaces || []).some((p) => { const a = norm(p.raw); return a.includes(t) || t.includes(a); });
      const wide = o.district_wide && o.districts.includes(placeOf(town).district);
      if (named || wide) return statusOf(o, now) === "active" ? "active" : "upcoming";
    }
    return null;
  };

  if (!counts.length) return null;
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const top = counts.slice(0, 10);
  return (
    <Panel title="Town watchlist" right={<span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{top.reduce((s, [, n]) => s + n, 0)}/{total} staff</span>}>
      <div className="space-y-1">
        {top.map(([town, n]) => {
          const f = flagFor(town);
          const tone = f === "active" ? C.red : f === "upcoming" ? C.amber : C.dim;
          return (
            <div key={town} className="flex items-center gap-2.5">
              <div style={{ color: f ? C.text : C.dim }} className="text-xs capitalize w-32 shrink-0 truncate">{town}</div>
              <div style={{ background: C.ink }} className="flex-1 h-3 rounded-sm overflow-hidden">
                <div style={{ background: f ? tone : C.panelHi, width: `${(n / top[0][1]) * 100}%` }} className="h-full rounded-sm" />
              </div>
              <div style={{ color: tone, fontFamily: MONO }} className="text-[11px] w-6 text-right">{n}</div>
              {f && <span style={{ background: tone }} className={`w-1.5 h-1.5 rounded-full ${f === "active" ? "animate-pulse" : ""}`} />}
            </div>
          );
        })}
      </div>
      <div style={{ color: C.dim, borderColor: C.line }} className="text-[10px] mt-3 pt-3 border-t leading-relaxed">
        Where your people actually live. A dot means a current notice names this town. Load shedding hits municipalities, so these are the entries that matter.
      </div>
    </Panel>
  );
}

function WeatherPanel({ towns, error }) {
  if (error || !towns.length) return null;
  const bad = towns.filter((t) => t.level !== "ok");
  return (
    <Panel title="Weather where staff live" right={<span style={{ color: bad.length ? C.amber : C.mint, fontFamily: MONO }} className="text-[10px]">{bad.length ? `${bad.length} flagged` : "all clear"}</span>}>
      <div className="space-y-1">
        {(bad.length ? bad : towns.slice(0, 6)).map((t) => {
          const tone = t.level === "severe" ? C.red : t.level === "watch" ? C.amber : C.dim;
          return (
            <div key={t.town} className="flex items-center justify-between gap-2 py-0.5">
              <div className="flex items-center gap-2 min-w-0">
                {t.level !== "ok" && <span style={{ background: tone }} className="w-1.5 h-1.5 rounded-full shrink-0" />}
                <span style={{ color: t.level === "ok" ? C.dim : C.text }} className="text-xs capitalize truncate">{t.town}</span>
                <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] shrink-0">{t.staff}</span>
              </div>
              <div style={{ color: tone, fontFamily: MONO }} className="text-[10px] shrink-0">
                {t.rainToday != null ? `${Math.round(t.rainToday)}mm` : ""}{t.gustToday ? ` · ${Math.round(t.gustToday)}km/h` : ""}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: C.dim, borderColor: C.line }} className="text-[10px] mt-3 pt-3 border-t leading-relaxed">
        Open-Meteo forecast per town, weighted by headcount. Storms and heavy rain take home workers offline as reliably as a feeder trip. NMS warnings publish only to Facebook — link below.
      </div>
    </Panel>
  );
}

function SourcesPanel() {
  const src = useSources();
  if (!src) return null;
  const Group = ({ label, items }) => (
    <div className="mb-2.5 last:mb-0">
      <div style={{ color: C.dim, fontFamily: MONO }} className="text-[9px] uppercase tracking-widest mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
             style={{ borderColor: l.live ? "rgba(79,191,159,0.4)" : C.line, color: l.live ? C.mint : C.dim, background: "rgba(255,255,255,0.02)" }}
             className="text-[11px] px-2 py-1 rounded border flex items-center gap-1 hover:opacity-80">
            {l.live && <span style={{ background: C.mint }} className="w-1.5 h-1.5 rounded-full" />}
            {l.name} <ExternalLink size={9} />
          </a>
        ))}
      </div>
    </div>
  );
  return (
    <Panel title="Check directly">
      <Group label="Power" items={src.power} />
      <Group label="Weather" items={src.weather} />
      <Group label="Internet" items={src.isp} />
      <div style={{ color: C.dim, borderColor: C.line }} className="text-[10px] mt-3 pt-3 border-t leading-relaxed">
        A green dot means this dashboard reads it automatically. The rest are Facebook pages, which block automated access — nobody can scrape them, so someone has to look.
      </div>
    </Panel>
  );
}

/* ----------------------------- schedule tab --------------------------- */
const FIELDS = [
  ["agent", "Agent name", true], ["date", "Date", true], ["start", "Start time", false],
  ["end", "End time", false], ["shift", "Shift (combined)", false], ["site", "Site / team", false],
  ["place", "Town / address", false], ["role", "Role", false],
];

function ScheduleTab({ outages, agents, rosterLoading, onShiftsResolved }) {
  const [rows, setRows] = useState(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState({});
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState(null);
  const [showMap, setShowMap] = useState(false);
  const [siteFilter, setSiteFilter] = useState(BELIZE_SITE);
  const [showPossible, setShowPossible] = useState({});
  const inputRef = useRef(null);
  useTick();


  const headers = rows ? (rows[headerRow] || []).map((h, i) => String(h || `Column ${i + 1}`)) : [];
  const onFile = async (file) => {
    if (!file) return;
    setErr(null);
    try {
      const data = await readWorkbook(file);
      if (!data.length) throw new Error("That file has no rows.");
      const hr = findHeaderRow(data);
      const m = autoMap(data[hr] || []);
      setRows(data); setHeaderRow(hr); setMap(m); setFileName(file.name);
      if (m.agent == null || (m.date == null && m.shift == null && m.start == null)) setShowMap(true);
    } catch (e) { setErr(e.message); }
  };

  const parsed = useMemo(() => (rows && map.agent != null ? buildShifts(rows, headerRow, map) : null), [rows, headerRow, map]);
  const sites = useMemo(() => [...new Set((parsed?.shifts || []).map((s) => s.site).filter(Boolean))], [parsed]);
  useEffect(() => {
    // PDF parser already drops non-[C] shifts, and CSVs with a Site column
    // let users switch manually. If a CSV has no Site column, stay on [C]
    // and show empty — no [C] tag means not Belize per staffing's rule.
    if (!sites.length) return;
    if (!sites.includes(siteFilter)) setSiteFilter(sites.includes(BELIZE_SITE) ? BELIZE_SITE : "all");
  }, [sites]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => (parsed ? analyze(parsed.shifts, outages, agents, siteFilter) : null), [parsed, outages, agents, siteFilter]);

  // Publish the site-filtered shifts to the parent so the Grid Status
  // tab can cross-reference against them without having to re-parse.
  const filteredShifts = useMemo(() => {
    if (!parsed?.shifts) return null;
    return parsed.shifts.filter((s) => siteFilter === "all" || s.site === siteFilter);
  }, [parsed, siteFilter]);
  useEffect(() => {
    if (onShiftsResolved) onShiftsResolved(filteredShifts && filteredShifts.length ? filteredShifts : null);
  }, [filteredShifts, onShiftsResolved]);

  const now = new Date();
  const G = result?.groups || [];

  // People on the schedule with no usable address. Aggregated per person with
  // their hours, so the size of the blind spot is visible rather than implied.
  const missing = useMemo(() => {
    const m = new Map();
    (result?.unknown || []).forEach((u) => {
      const h = (u.end - u.start) / 3600000;
      m.set(u.agent, (m.get(u.agent) || 0) + h);
    });
    return [...m.entries()].map(([agent, hours]) => ({ agent, hours: Math.round(hours * 10) / 10 }))
      .sort((a, b) => b.hours - a.hours);
  }, [result]);
  const missingHours = Math.round(missing.reduce((s, m) => s + m.hours, 0) * 10) / 10;
  const liveG = G.filter((g) => statusOf(g.outage, now) === "active");
  const nextG = G.filter((g) => statusOf(g.outage, now) !== "active");
  const onNow = new Set(liveG.flatMap((g) => g.confirmed.filter((s) => s.start <= now && s.end >= now).map((s) => s.agent))).size;
  const next12 = new Set(G.filter((g) => { const h = hoursUntil(g.outage, now); return h > 0 && h <= 12; }).flatMap((g) => g.confirmed.map((s) => s.agent))).size;
  const weekConfirmed = new Set(G.flatMap((g) => g.confirmed.map((s) => s.agent))).size;
  const weekWatch = new Set(G.flatMap((g) => g.possible.map((s) => s.agent))).size;

  const downloadCSV = () => {
    if (!result) return;
    const head = ["Tier", "Status", "Town", "District", "Outage window", "Agent", "Role", "Shift", "Dark from", "Dark to", "Hours lost", "% of shift"];
    const lines = G.flatMap((g) => [...g.confirmed, ...g.possible].map((s) => [
      s.tier === "confirmed" ? "REPLACE" : "MONITOR",
      statusOf(g.outage, now) === "active" ? "OUT NOW" : "UPCOMING",
      s.town || "", s.district || "", windowLabel(g.outage), s.agent, s.role,
      `${fmtDay(s.start)} ${fmtTime(s.start)}-${fmtTime(s.end)}`,
      fmtTime(s.from), fmtTime(s.to), hrs(s.lost), `${s.pct}%`,
    ]));
    const csv = [head, ...lines].map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `affected-staff-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  if (!rows) {
    return (
      <Panel>
        <div className="py-10 flex flex-col items-center text-center">
          <div style={{ background: C.panelHi, borderColor: C.line }} className="w-14 h-14 rounded-xl border flex items-center justify-center mb-4">
            <FileSpreadsheet size={24} style={{ color: C.gold }} />
          </div>
          <div className="text-lg font-semibold mb-1">Load this week's schedule</div>
          <div style={{ color: C.dim }} className="text-sm max-w-md mb-5 leading-relaxed">
            PDF, CSV, or Excel with a name, a date, and shift times. WFM PDF exports are parsed directly. Towns come from the monday.com address board.
          </div>
          {err && <div style={{ color: C.red }} className="text-sm mb-3">{err}</div>}
          <button onClick={() => inputRef.current?.click()} style={{ background: C.gold, color: C.ink }} className="px-4 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2">
            <Upload size={15} /> Choose file
          </button>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          {!agents.length && !rosterLoading && (
            <div style={{ color: C.amber }} className="text-xs mt-5 flex items-center gap-1.5"><AlertTriangle size={13} /> Address board not loaded — nothing can be matched yet.</div>
          )}
        </div>
      </Panel>
    );
  }

  const Row = ({ s, live, dim }) => {
    const mid = s.start <= now && s.end >= now;
    return (
      <div className="px-3 py-2 flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          {mid && live && !dim && <span style={{ background: C.red }} className="w-2 h-2 rounded-full shrink-0 animate-pulse" />}
          <div className="min-w-0">
            <div style={{ color: dim ? C.dim : C.text }} className="text-sm truncate">{s.agent}</div>
            {/* Shift times are shown in Eastern to match the WFM. */}
            <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] flex items-center gap-1 capitalize">
              {s.town || s.district} · {fmtDayET(s.start)} {fmtTimeET(s.start)}–{fmtTimeET(s.end)} ET
              {fmtDayET(s.start) !== fmtDayET(s.end) && <Moon size={9} />}
            </div>
          </div>
        </div>
        {/* "Dark from - to" is the outage overlap window shown in BZ, which
            matches the outage source and lets a US-based staffer see the
            outage frame at a glance next to the agent's ET shift. */}
        <div className="text-right shrink-0">
          <div style={{ color: dim ? C.dim : s.pct >= 85 ? C.red : C.amber, fontFamily: MONO }} className="text-xs">{fmtTime(s.from)}–{fmtTime(s.to)} BZ</div>
          <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{hrs(s.lost)}h · {s.pct}%</div>
        </div>
      </div>
    );
  };

  const renderGroup = (g) => {
    const live = statusOf(g.outage, now) === "active";
    const h = hoursUntil(g.outage, now);
    const open = showPossible[g.outage.id];
    const none = g.headcount === 0;
    return (
      <div key={g.outage.id} style={{ background: live && !none ? "rgba(216,80,63,0.06)" : "rgba(255,255,255,0.02)", borderColor: none ? C.line : live ? "rgba(216,80,63,0.35)" : C.line }} className="rounded-xl border overflow-hidden">
        <div style={{ borderColor: C.line }} className="p-3 border-b flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <Pill tone={none ? "quiet" : live ? "active" : "upcoming"}>{live ? "Dark now" : h < 24 ? `in ${Math.max(0, Math.round(h))}h` : "Scheduled"}</Pill>
              {g.outage.type === "load_shedding" && <Pill tone="gold">Load shed</Pill>}
              {g.wide && <Pill tone="active">District-wide</Pill>}
            </div>
            <div className="text-sm font-semibold">{g.outage.districts.join(" · ")}</div>
            <div style={{ color: C.dim, fontFamily: MONO }} className="text-[11px] mt-0.5">{windowLabel(g.outage)}</div>
            {g.outage.loadCenter && (
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mt-0.5">
                Load centre {g.outage.loadCenter}{g.outage.feeder ? ` · feeder ${g.outage.feeder}` : ""}{g.outage.zone ? ` · zone ${g.outage.zone}` : ""}
              </div>
            )}
            {g.outage.excludes?.length > 0 && (
              <div style={{ color: C.mint }} className="text-[10px] mt-1">Exempt: {g.outage.excludes.join(", ")}</div>
            )}
            {g.outage.areaPlaces?.length > 0 && (
              <div style={{ color: C.dim }} className="text-[11px] mt-1.5 leading-relaxed max-w-lg">
                {g.outage.areaPlaces.slice(0, 8).map((p) => p.raw).join(", ")}{g.outage.areaPlaces.length > 8 ? ` +${g.outage.areaPlaces.length - 8}` : ""}
              </div>
            )}
          </div>
          <div className="text-right">
            <div style={{ color: none ? C.dim : live ? C.red : C.amber, fontFamily: MONO }} className="text-3xl font-bold leading-none">{g.headcount}</div>
            <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest mt-1">to replace</div>
          </div>
        </div>

        {none ? (
          <div style={{ color: C.mint }} className="px-3 py-2.5 text-xs flex items-center gap-2">
            <CheckCircle2 size={13} /> No scheduled staff live in the areas this notice names.
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: C.line }}>
            {g.confirmed.map((s) => <Row key={s.key + g.outage.id} s={s} live={live} />)}
          </div>
        )}

        {g.watching > 0 && (
          <div style={{ borderColor: C.line, background: "rgba(0,0,0,0.15)" }} className="border-t">
            <button onClick={() => setShowPossible((p) => ({ ...p, [g.outage.id]: !open }))} className="w-full px-3 py-2 flex items-center justify-between gap-2">
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest flex items-center gap-1.5">
                <Eye size={11} /> {g.watching} more in {g.outage.districts.join("/")} — town not named
              </span>
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{open ? "hide" : "show"}</span>
            </button>
            {open && <div className="divide-y" style={{ borderColor: C.line }}>{g.possible.map((s) => <Row key={s.key + g.outage.id} s={s} live={live} dim />)}</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileSpreadsheet size={18} style={{ color: C.gold }} className="shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{fileName}</div>
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">
                {result?.totalCount || 0} shifts · {result?.placedCount || 0} located
                {result?.unknown.length ? ` · ${new Set(result.unknown.map((u) => u.agent)).size} no address` : ""}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {sites.length > 0 && (
              <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="px-2.5 py-2 rounded-lg border text-xs">
                {sites.includes(BELIZE_SITE) && <option value={BELIZE_SITE}>Belize only [C]</option>}
                <option value="all">All sites (incl. US/remote)</option>
                {sites.filter((s) => s !== BELIZE_SITE).map((s) => <option key={s} value={s}>Site {s}</option>)}
              </select>
            )}
            <button onClick={() => setShowMap((v) => !v)} style={{ borderColor: C.line, color: C.dim }} className="px-3 py-2 rounded-lg border text-xs">Columns</button>
            <button onClick={() => inputRef.current?.click()} style={{ borderColor: C.line, color: C.dim }} className="px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5"><Upload size={12} /> Replace</button>
            <button onClick={downloadCSV} disabled={!G.length} style={{ background: C.gold, color: C.ink }} className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"><Download size={12} /> Export</button>
          </div>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        {showMap && (
          <div style={{ borderColor: C.line }} className="mt-4 pt-4 border-t grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {FIELDS.map(([f, label, req]) => (
              <label key={f} className="block">
                <span style={{ color: req ? C.goldSoft : C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">{label}{req ? " *" : ""}</span>
                <select value={map[f] ?? ""} onChange={(e) => setMap({ ...map, [f]: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm">
                  <option value="">— none —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
      </Panel>

      {missing.length > 0 && (
        <div style={{ background: "rgba(232,163,61,0.09)", borderColor: "rgba(232,163,61,0.4)" }} className="rounded-xl border p-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} style={{ color: C.amber }} className="shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div style={{ color: C.amber }} className="text-sm font-semibold">
                {missing.length} scheduled {missing.length === 1 ? "person has" : "people have"} no address on file
                {missingHours > 0 ? ` · ${missingHours}h this week` : ""}
              </div>
              <div style={{ color: C.text }} className="text-xs mt-1 leading-relaxed">
                They are excluded from every count below. If an outage hits their town, this dashboard will not show it.
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {missing.map((m) => (
                  <span key={m.agent} style={{ background: "rgba(232,163,61,0.13)", borderColor: "rgba(232,163,61,0.35)", color: C.goldSoft }} className="text-[11px] px-2 py-0.5 rounded border">
                    {m.agent}{m.hours ? ` · ${m.hours}h` : ""}
                  </span>
                ))}
              </div>
              <a href={BOARD_URL} target="_blank" rel="noreferrer" style={{ color: C.goldSoft, fontFamily: MONO }} className="text-[11px] mt-2.5 inline-flex items-center gap-1 hover:underline">
                Add them on the address board <ExternalLink size={10} />
              </a>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Radio} label="Dark now, on shift" value={onNow} tone={onNow ? C.red : C.mint} />
        <Stat icon={Clock} label="Confirmed next 12h" value={next12} tone={next12 ? C.amber : C.mint} />
        <Stat icon={Users} label="Confirmed this week" value={weekConfirmed} tone={weekConfirmed ? C.amber : C.mint} />
        <Stat icon={Eye} label="Monitoring" value={weekWatch} tone={C.dim} sub="Right district, town not named" />
      </div>

      {liveG.length > 0 && (
        <div>
          <div style={{ color: C.red, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <span style={{ background: C.red }} className="w-2 h-2 rounded-full animate-pulse" /> Happening now
          </div>
          <div className="space-y-3">{liveG.map(renderGroup)}</div>
        </div>
      )}

      <div>
        <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest mb-2">Coming up</div>
        {nextG.length === 0 ? (
          <Panel><div style={{ color: C.mint }} className="text-sm py-6 text-center">No upcoming notice overlaps a scheduled shift.</div></Panel>
        ) : <div className="space-y-3">{nextG.map(renderGroup)}</div>}
      </div>

      {parsed?.problems.length > 0 && (
        <Panel title="Rows that could not be read">
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {parsed.problems.slice(0, 20).map((p, i) => (
              <div key={`p${i}`} className="flex items-center justify-between text-xs py-1">
                <span>{p.agent} <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">row {p.row}</span></span>
                <span style={{ color: C.amber, fontFamily: MONO }} className="text-[10px]">{p.reason}</span>
              </div>
            ))}
          </div>
          <div style={{ color: C.dim, borderColor: C.line }} className="text-[10px] mt-3 pt-3 border-t leading-relaxed">
            These schedule rows had no readable date or shift time, so they were skipped entirely.
          </div>
        </Panel>
      )}
    </div>
  );
}

/* -------------------- staff in affected areas ------------------------- */
// Location-only affected list — doesn't require an uploaded schedule.
// Same tier logic as analyze(): confirmed = district-wide or town-named,
// monitoring = right district, town not in the notice, exempt = town in
// the notice's excludes clause.
// If `shifts` are provided, only agents with a shift that overlaps the
// outage window survive — turns the panel from "who lives here" into
// "who is scheduled AND lives here", which is the actionable list.
// Without shifts, falls back to the location-only view.
function computeHomeAffected(agents, outages, opts = {}) {
  const { shifts = null, now = new Date() } = opts;

  let shiftsByAgentId = null;
  if (shifts && shifts.length) {
    const nameLookup = new Map();
    for (const a of agents) {
      for (const k of nameKeys(a.name)) if (!nameLookup.has(k)) nameLookup.set(k, a);
    }
    shiftsByAgentId = new Map();
    for (const s of shifts) {
      const agent = (s.keys || []).map((k) => nameLookup.get(k)).find(Boolean);
      if (!agent) continue;
      if (!shiftsByAgentId.has(agent.id)) shiftsByAgentId.set(agent.id, []);
      shiftsByAgentId.get(agent.id).push(s);
    }
  }

  const groups = [];
  for (const o of outages) {
    if (statusOf(o, now) === "past") continue;
    const oS = parseTs(o.start), oE = parseTs(o.end);
    const areaNames = (o.areaPlaces || []).map((p) => norm(p.raw)).filter((x) => x.length >= 4);
    const exNames = (o.excludePlaces || o.excludes || []).map((p) => norm(p.raw ?? p)).filter((x) => x.length >= 4);
    const wide = o.district_wide || areaNames.length === 0;
    let rows = agents
      .filter((a) => a.district && o.districts.includes(a.district))
      .map((a) => {
        const t = norm(a.town || "");
        const exempt = t.length >= 4 && exNames.some((n) => n.includes(t) || t.includes(n));
        const named = t.length >= 4 && areaNames.some((n) => n.includes(t) || t.includes(n));
        return { agent: a, tier: exempt ? "exempt" : wide || named ? "confirmed" : "monitoring" };
      });

    if (shiftsByAgentId) {
      rows = rows
        .map((r) => {
          const list = shiftsByAgentId.get(r.agent.id) || [];
          const overlapping = list.filter((s) => overlapMs(s.start, s.end, oS, oE) > 0);
          return overlapping.length ? { ...r, shifts: overlapping } : null;
        })
        .filter(Boolean);
    }

    rows.sort((a, b) => (a.tier === b.tier ? a.agent.name.localeCompare(b.agent.name) : a.tier === "confirmed" ? -1 : b.tier === "confirmed" ? 1 : 0));
    if (rows.length) groups.push({ outage: o, rows });
  }
  return groups;
}

function AffectedStaffPanel({ agents, outages, shifts, onOpenSchedule }) {
  const groups = useMemo(() => computeHomeAffected(agents, outages, { shifts }), [agents, outages, shifts]);
  if (!groups.length) return null;
  const now = new Date();
  const totalConfirmed = new Set(groups.flatMap((g) => g.rows.filter((r) => r.tier === "confirmed").map((r) => r.agent.name))).size;

  return (
    <Panel
      title="Staff in affected areas"
      right={<span style={{ color: totalConfirmed ? C.red : C.amber, fontFamily: MONO }} className="text-[10px]">{totalConfirmed} to replace</span>}
    >
      <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
        {groups.map((g) => {
          const st = statusOf(g.outage, now);
          return (
            <div key={g.outage.id} style={{ borderColor: C.line }} className="pb-3 border-b last:border-b-0 last:pb-0">
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                <Pill tone={st === "active" ? "active" : "upcoming"}>{st === "active" ? "Dark now" : "Scheduled"}</Pill>
                <span style={{ color: C.text, fontFamily: MONO }} className="text-[11px] font-semibold">{g.outage.districts.join(" · ")}</span>
              </div>
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mb-2">{windowLabel(g.outage)}</div>
              <div className="space-y-0.5">
                {g.rows.map(({ agent, tier }) => {
                  // Exempt = "keeps power, not at risk" — teal-mint feels
                  // too much like "all clear". Use dim so it visually
                  // recedes below the actionable tiers.
                  const tone = tier === "confirmed" ? C.red : tier === "exempt" ? C.dim : C.amber;
                  return (
                    <div key={agent.id + g.outage.id} className="flex items-center justify-between gap-2 py-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span style={{ background: tone }} className="w-1.5 h-1.5 rounded-full shrink-0" />
                        <span style={{ color: C.text }} className="text-xs truncate">{agent.name}</span>
                        <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] capitalize shrink-0">{agent.town || agent.district}</span>
                      </div>
                      <span style={{ color: tone, fontFamily: MONO }} className="text-[9px] uppercase tracking-widest shrink-0">
                        {tier === "confirmed" ? "Replace" : tier === "exempt" ? "Exempt" : "Monitor"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: C.dim, borderColor: C.line }} className="text-[10px] mt-3 pt-3 border-t leading-relaxed">
        {shifts && shifts.length
          ? <>Shift-matched — only agents scheduled during each outage window are shown. Full breakdown on <button onClick={onOpenSchedule} style={{ color: C.goldSoft }} className="underline">Affected staff</button>.</>
          : <>Location-only — anyone whose home is in an outage district. Upload the WFM schedule on <button onClick={onOpenSchedule} style={{ color: C.goldSoft }} className="underline">Affected staff</button> to filter to who is actually working.</>}
      </div>
    </Panel>
  );
}

/* ---------------------- manual ISP outage form ------------------------ */
const ISP_SOURCES = ["DigiBelize", "Smart", "Centaur Communications", "Nexgen", "Beeline", "BEL", "Other"];

function ManualOutageForm({ onClose, onSaved }) {
  // Default to *Belize* wall-clock time regardless of the browser's zone —
  // this form's timestamps are all interpreted as America/Belize downstream.
  const nowLocal = (() => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Belize",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  })();
  const [source, setSource] = useState("DigiBelize");
  const [type, setType] = useState("isp_outage");
  const [districts, setDistricts] = useState([]);
  const [areas, setAreas] = useState("");
  const [start, setStart] = useState(nowLocal);
  const [end, setEnd] = useState("");
  const [cause, setCause] = useState("");
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const fileInputRef = useRef(null);
  const extractInputRef = useRef(null);

  // Send the screenshot to the server for Gemini vision extraction, then
  // pre-fill any fields it could read. Also attach the same image so the
  // saved outage carries its own evidence.
  const extractFrom = async (file) => {
    if (!file) return;
    setExtracting(true); setExtractNote(null); setErr(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const r = await fetch(`${API}/extract-outage`, { method: "POST", credentials: "include", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Extraction failed (${r.status})`);
      if (data.source) setSource(data.source);
      if (data.type) setType(data.type);
      if (data.districts?.length) setDistricts(data.districts);
      if (data.areas?.length) setAreas(data.areas.join(", "));
      if (data.cause) setCause(data.cause);
      // Convert incoming ISO with -06:00 back into datetime-local shape.
      const toLocal = (iso) => {
        if (!iso) return null;
        const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        return m ? `${m[1]}T${m[2]}` : null;
      };
      const s = toLocal(data.start), e = toLocal(data.end);
      if (s) setStart(s);
      if (e) setEnd(e);
      // Ensure the file is attached even if extraction was triggered
      // directly from the vision zone. addFiles() de-dupes by only
      // appending files not already in the array.
      setFiles((prev) => prev.includes(file) || prev.length >= 10 ? prev : [...prev, file]);
      const filled = [
        data.source && "source",
        data.districts?.length && `${data.districts.length} district${data.districts.length !== 1 ? "s" : ""}`,
        data.areas?.length && `${data.areas.length} area${data.areas.length !== 1 ? "s" : ""}`,
        data.start && "start",
        data.end && "end",
        data.cause && "cause",
      ].filter(Boolean);
      setExtractNote(filled.length ? `Filled from screenshot: ${filled.join(", ")}. Review and submit.` : "Screenshot processed but nothing extracted. Fill manually.");
    } catch (e) { setErr(`Vision extraction: ${e.message}`); }
    finally { setExtracting(false); }
  };

  const toggle = (d) => setDistricts((s) => s.includes(d) ? s.filter((x) => x !== d) : [...s, d]);

  // As the user types area names, resolve any recognizable town to its
  // district and pre-add it. Doesn't remove manually-picked districts.
  useEffect(() => {
    const parts = areas.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const found = new Set();
    for (const a of parts) { const p = placeOf(a); if (p.district) found.add(p.district); }
    if (!found.size) return;
    setDistricts((prev) => {
      const next = new Set(prev);
      for (const d of found) next.add(d);
      return next.size === prev.length ? prev : [...next];
    });
  }, [areas]);

  const addFiles = (list) => {
    const arr = Array.from(list || []).slice(0, 10 - files.length);
    setFiles((prev) => [...prev, ...arr]);
    // Auto-run vision on the first image if extraction hasn't happened
    // yet — merging the "attach" and "auto-fill" flows so users can't
    // drop a screenshot into the wrong zone and miss the AI step.
    if (!extractNote && !extracting) {
      const firstImage = arr.find((f) => f.type.startsWith("image/"));
      if (firstImage) extractFrom(firstImage);
    }
  };
  const removeFile = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  // datetime-local input gives no offset — treat it as Belize local time.
  const toBelizeIso = (v) => v ? `${v}:00-06:00` : null;

  const submit = async () => {
    setErr(null);
    // If the user has attached anything or run vision extraction, trust
    // them — save the entry even without a district. It shows up in the
    // feed and can be corrected later. Only block empty-district saves
    // when the form is genuinely being filled by hand with no evidence.
    if (!districts.length && !files.length && !extractNote) {
      setErr("Pick at least one district (or drop a screenshot to auto-fill).");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/manual-outages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          source, type,
          districts,
          areas: areas.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
          start: toBelizeIso(start),
          end: toBelizeIso(end),
          cause,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Save failed (${r.status})`);

      // Upload any attached files after the outage entry exists.
      if (files.length && data.entry?.id) {
        const fd = new FormData();
        for (const f of files) fd.append("files", f);
        const ur = await fetch(`${API}/manual-outages/${encodeURIComponent(data.entry.id)}/attachments`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!ur.ok) {
          const ud = await ur.json().catch(() => ({}));
          throw new Error(ud.error || `Attachment upload failed (${ur.status})`);
        }
      }

      onSaved();
      onClose();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div onClick={onClose} style={{ background: "rgba(0,0,0,0.6)" }} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, borderColor: C.line }} className="w-full max-w-lg rounded-xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Log outage</h3>
          <button onClick={onClose}><X size={16} style={{ color: C.dim }} /></button>
        </div>

        {/* Vision extraction — drop a Facebook/BEL-app screenshot and let
            Gemini pre-fill the form. The image is kept as an attachment. */}
        <div
          onClick={() => !extracting && extractInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            const f = Array.from(e.dataTransfer.files || []).find((x) => x.type.startsWith("image/"));
            if (f && !extracting) extractFrom(f);
          }}
          style={{
            background: extracting ? "rgba(201,162,39,0.10)" : "rgba(79,191,159,0.06)",
            borderColor: extracting ? C.gold : "rgba(79,191,159,0.35)",
            borderStyle: "dashed",
            cursor: extracting ? "wait" : "pointer",
          }}
          className="mb-4 rounded-lg border p-3 text-center"
        >
          <div className="flex items-center justify-center gap-2">
            {extracting ? <RefreshCw size={13} className="animate-spin" style={{ color: C.gold }} /> : <span style={{ color: C.mint }}>✨</span>}
            <span style={{ color: extracting ? C.gold : C.text }} className="text-xs font-semibold">
              {extracting ? "Reading screenshot with Gemini…" : "Auto-fill from screenshot"}
            </span>
          </div>
          <div style={{ color: C.dim }} className="text-[10px] mt-0.5">
            Drop a screenshot of a Facebook post, BEL 24/7 app screen, or news article — the form fills itself.
          </div>
          <input
            ref={extractInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => extractFrom(e.target.files?.[0])}
          />
        </div>
        {extractNote && (
          <div style={{ color: C.mint, background: "rgba(79,191,159,0.08)", borderColor: "rgba(79,191,159,0.3)" }} className="mb-3 p-2 rounded-lg border text-[11px]">
            {extractNote}
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Source *</span>
              <select value={source} onChange={(e) => setSource(e.target.value)} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm">
                {ISP_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block">
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Type</span>
              <select value={type} onChange={(e) => setType(e.target.value)} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm">
                <option value="isp_outage">ISP outage</option>
                <option value="load_shedding">Load shedding</option>
                <option value="planned">Planned power</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span style={{ color: districts.length ? C.dim : C.amber, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Districts *</span>
              <span style={{ color: districts.length ? C.mint : C.amber, fontFamily: MONO }} className="text-[10px]">
                {districts.length ? `${districts.length} picked` : "None selected — tap to pick"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {DISTRICTS.map((d) => {
                const on = districts.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => toggle(d)}
                    style={{
                      background: on ? C.gold : "transparent",
                      color: on ? C.ink : C.text,
                      borderColor: on ? C.gold : C.line,
                      fontWeight: on ? 700 : 500,
                    }}
                    className="px-2.5 py-1 rounded border text-xs transition-colors hover:opacity-90"
                  >
                    {on && "✓ "}{d}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Start * (BZ)</span>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm" />
            </label>
            <label className="block">
              <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">End (BZ)</span>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm" />
            </label>
          </div>

          <label className="block">
            <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Areas (comma-separated)</span>
            <input type="text" value={areas} onChange={(e) => setAreas(e.target.value)} placeholder="Belmopan, San Ignacio" style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm" />
            <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">Leave blank for district-wide.</span>
          </label>

          <label className="block">
            <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Cause / note</span>
            <input type="text" value={cause} onChange={(e) => setCause(e.target.value)} maxLength={200} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="w-full mt-1 px-2.5 py-2 rounded-lg border text-sm" />
          </label>

          <div>
            <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">Evidence (screenshots, PDFs)</span>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                background: dragging ? "rgba(201,162,39,0.10)" : C.ink,
                borderColor: dragging ? C.gold : C.line,
                borderStyle: "dashed",
              }}
              className="mt-1 rounded-lg border p-3 text-center cursor-pointer transition-colors"
            >
              <div style={{ color: C.dim }} className="text-xs">
                {dragging ? "Drop to attach" : files.length ? `${files.length} file${files.length !== 1 ? "s" : ""} ready` : "Drag files here or click to browse"}
              </div>
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mt-0.5">Up to 10 files, 10 MB each</div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.log"
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {files.map((f, i) => (
                  <span key={i} style={{ background: C.ink, borderColor: C.line, color: C.text }} className="text-[11px] px-2 py-1 rounded border flex items-center gap-1.5">
                    <span className="truncate max-w-[180px]">{f.name}</span>
                    <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{(f.size / 1024).toFixed(0)}k</span>
                    <button onClick={(e) => { e.stopPropagation(); removeFile(i); }} style={{ color: C.dim }}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {err && <div style={{ color: C.red }} className="text-xs">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} style={{ borderColor: C.line, color: C.dim }} className="px-3 py-2 rounded-lg border text-sm">Cancel</button>
          <button onClick={submit} disabled={saving} style={{ background: C.gold, color: C.ink }} className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
            {saving ? "Saving…" : "Log outage"}
          </button>
        </div>
      </div>
    </div>
  );
}

async function deleteManualOutage(id) {
  const r = await fetch(`${API}/manual-outages/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(`Delete failed (${r.status})`);
}

/* ================================ app ================================= */
export default function BelizeGridWatch() {
  const [tab, setTab] = useState("grid");
  const [showCfg, setShowCfg] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);
  const [selected, setSelected] = useState(null);
  // ScheduleTab publishes its resolved shifts here so the Grid Status
  // components can cross-reference against the schedule too.
  const [scheduleShifts, setScheduleShifts] = useState(null);
  const { outages, grid, loading, error, checked, reload } = useOutages();
  const roster = useRoster();
  const weather = useWeather();
  useTick();

  const now = new Date();
  const liveOutages = outages.filter((o) => statusOf(o, now) === "active").length;
  const upcomingOutages = outages.filter((o) => statusOf(o, now) === "upcoming").length;
  const severeWeather = weather.towns.filter((w) => w.level === "severe").length;
  const watchWeather = weather.towns.filter((w) => w.level === "watch").length;
  const alertActive = liveOutages || upcomingOutages || severeWeather || watchWeather;

  // Roster-based confirmed replacements. Distinct-by-name; sort the
  // source groups by active-first BEFORE dedup so someone flagged in
  // BOTH a live and an upcoming outage always renders with the live
  // badge (previously the badge came from whichever group appeared
  // first in the outages array, which was arbitrary).
  const replacements = useMemo(() => {
    const groups = computeHomeAffected(roster.agents, outages, { shifts: scheduleShifts, now });
    const sorted = [...groups].sort((a, b) => {
      const aActive = statusOf(a.outage, now) === "active";
      const bActive = statusOf(b.outage, now) === "active";
      return aActive === bActive ? 0 : aActive ? -1 : 1;
    });
    const seen = new Set();
    const out = [];
    for (const g of sorted) {
      const active = statusOf(g.outage, now) === "active";
      for (const r of g.rows) {
        if (r.tier !== "confirmed") continue;
        if (seen.has(r.agent.name)) continue;
        seen.add(r.agent.name);
        out.push({ agent: r.agent, active, outage: g.outage });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.agents, outages, scheduleShifts]);

  const byDistrict = useMemo(() => {
    const m = {};
    for (const d of DISTRICTS) {
      const os = outages.filter((o) => o.districts.includes(d));
      m[d] = { worst: os.some((o) => statusOf(o) === "active") ? "active" : os.length ? "upcoming" : null, staff: roster.agents.filter((a) => a.district === d).length };
    }
    return m;
  }, [outages, roster.agents]);

  const visible = selected ? outages.filter((o) => o.districts.includes(selected)) : outages;
  const gridTone = grid?.status === "emergency" ? C.red : grid?.status === "strained" ? C.amber : C.mint;

  return (
    <div style={{ background: C.ink, color: C.text, fontFamily: SANS, minHeight: "100%" }} className="p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4 pb-4" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div>
          <div style={{ color: C.gold, fontFamily: MONO }} className="text-[10px] tracking-[0.3em] uppercase mb-1">Answering Legal · Workforce Continuity</div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Belize Grid Watch</h1>
          <div style={{ color: C.dim }} className="text-xs mt-1">Matched by town, not district. Who is dark now, and who goes dark next.</div>
          <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span><span style={{ color: C.goldSoft }}>BZ</span> = Belize (outages, weather, notices)</span>
            <span><span style={{ color: C.goldSoft }}>ET</span> = Eastern (uploaded schedule shifts)</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCfg((v) => !v)} style={{ borderColor: C.line, color: C.dim }} className="px-3 py-2 rounded-lg border text-xs flex items-center gap-2"><Settings size={13} /> Addresses</button>
          <button onClick={() => reload(true)} disabled={loading} style={{ background: C.gold, color: C.ink }} className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {loading ? "Checking" : "Refresh"}
          </button>
        </div>
      </div>

      {replacements.length > 0 && (() => {
        const liveReps = replacements.filter((r) => r.active);
        const upcomingReps = replacements.filter((r) => !r.active);
        return (
          <div
            style={{
              background: liveReps.length ? "rgba(216,80,63,0.10)" : "rgba(232,163,61,0.08)",
              borderColor: liveReps.length ? "rgba(216,80,63,0.5)" : "rgba(232,163,61,0.45)",
            }}
            className="mb-4 rounded-2xl border p-4 md:p-5"
          >
            {/* Header splits live vs upcoming so a single scary total
                doesn't hide what's actually actionable right now. */}
            <div className="flex flex-wrap items-center gap-4 mb-3">
              {liveReps.length > 0 && (
                <div className="flex items-center gap-2">
                  <div style={{ background: C.red }} className="w-3 h-3 rounded-full animate-pulse" />
                  <div style={{ color: C.red, fontFamily: MONO }} className="text-[11px] uppercase tracking-[0.25em] font-bold">
                    Replace now · {liveReps.length}
                  </div>
                </div>
              )}
              {upcomingReps.length > 0 && (
                <div className="flex items-center gap-2">
                  <div style={{ background: C.amber }} className="w-2.5 h-2.5 rounded-full" />
                  <div style={{ color: C.amber, fontFamily: MONO }} className="text-[11px] uppercase tracking-[0.25em] font-bold">
                    Upcoming · {upcomingReps.length}
                  </div>
                </div>
              )}
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] ml-auto">
                home town in an outage area
              </div>
            </div>

            {liveReps.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 mb-3">
                {liveReps.map(({ agent, outage }) => (
                  <div
                    key={agent.name + outage.id}
                    style={{ background: C.panel, borderColor: "rgba(216,80,63,0.35)" }}
                    className="rounded-lg border p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <div style={{ color: C.text }} className="text-base md:text-lg font-semibold truncate">{agent.name}</div>
                      <div style={{ color: C.red, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest shrink-0">Dark now</div>
                    </div>
                    <div style={{ color: C.dim, fontFamily: MONO }} className="text-[11px] capitalize">
                      {agent.town || agent.district} · {windowLabel(outage)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {upcomingReps.length > 0 && (
              <div>
                {liveReps.length > 0 && (
                  <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest mb-1.5">
                    Coming up
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {upcomingReps.map(({ agent, outage }) => (
                    <div
                      key={agent.name + outage.id}
                      style={{ background: "rgba(255,255,255,0.02)", borderColor: C.line }}
                      className="rounded-lg border p-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div style={{ color: C.text }} className="text-sm font-semibold truncate">{agent.name}</div>
                        <div style={{ color: C.amber, fontFamily: MONO }} className="text-[9px] uppercase tracking-widest shrink-0">Upcoming</div>
                      </div>
                      <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] capitalize">
                        {agent.town || agent.district} · {windowLabel(outage)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ color: C.dim }} className="text-[11px] mt-3">
              Location-based: town matches the outage notice. Open <button onClick={() => setTab("schedule")} style={{ color: C.goldSoft }} className="underline">Affected staff</button> to layer in their shifts once the schedule is uploaded.
            </div>
          </div>
        );
      })()}

      {showCfg && (
        <Panel className="mb-4">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div style={{ color: C.dim }} className="text-xs leading-relaxed">
              Addresses come from the monday.com board via the server. Change the board or group with
              <span style={{ fontFamily: MONO, color: C.goldSoft }}> GRID_BOARD_ID</span> and
              <span style={{ fontFamily: MONO, color: C.goldSoft }}> GRID_GROUP_MATCH</span> in your env, then reload.
            </div>
            <button onClick={() => setShowCfg(false)}><X size={14} style={{ color: C.dim }} /></button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={roster.reload} disabled={roster.loading} style={{ background: C.panelHi, color: C.text, borderColor: C.line }} className="px-4 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-50">
              <RefreshCw size={12} className={roster.loading ? "animate-spin" : ""} /> {roster.loading ? "Reading…" : "Reload addresses"}
            </button>
            <span style={{ color: roster.error ? C.amber : C.dim, fontFamily: MONO }} className="text-[10px]">
              {roster.error || (roster.loading ? "Reading board…" : `${roster.agents.length} people · ${new Set(roster.agents.map((a) => a.town).filter(Boolean)).size} towns`)}
            </span>
          </div>
        </Panel>
      )}

      {alertActive > 0 && (
        <button
          onClick={() => setTab("grid")}
          style={{
            // Bar tone reflects OUTAGES only — weather is informational and
            // must not read as an outage. Neutral when only weather flags.
            background: liveOutages ? "rgba(216,80,63,0.08)" : upcomingOutages ? "rgba(232,163,61,0.06)" : "rgba(255,255,255,0.02)",
            borderColor: liveOutages ? "rgba(216,80,63,0.4)" : upcomingOutages ? "rgba(232,163,61,0.35)" : C.line,
            color: C.text,
          }}
          className="w-full mb-4 p-3 rounded-xl border flex flex-wrap items-center gap-4 text-left hover:opacity-90 transition-opacity"
        >
          {liveOutages > 0 && (
            <span style={{ color: C.red, fontFamily: MONO }} className="text-xs flex items-center gap-1.5">
              <span style={{ background: C.red }} className="w-2 h-2 rounded-full animate-pulse" />
              {liveOutages} outage{liveOutages !== 1 ? "s" : ""} live now
            </span>
          )}
          {upcomingOutages > 0 && (
            <span style={{ color: C.amber, fontFamily: MONO }} className="text-xs flex items-center gap-1.5">
              <Clock size={12} /> {upcomingOutages} outage{upcomingOutages !== 1 ? "s" : ""} scheduled
            </span>
          )}
          {(severeWeather > 0 || watchWeather > 0) && (
            <span style={{ color: C.dim, fontFamily: MONO }} className="text-xs flex items-center gap-1.5" title="Weather is informational, not treated as an outage.">
              <span style={{ background: severeWeather ? C.amber : C.mint, opacity: 0.7 }} className="w-1.5 h-1.5 rounded-full" />
              weather: {severeWeather > 0 ? `${severeWeather} severe` : ""}{severeWeather > 0 && watchWeather > 0 ? " · " : ""}{watchWeather > 0 ? `${watchWeather} watch` : ""}
            </span>
          )}
          <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] ml-auto">
            {tab === "grid" ? "Details below ↓" : "Open Grid status →"}
          </span>
        </button>
      )}

      <div className="flex gap-1 mb-4">
        {[["grid", "Grid status", MapIcon], ["schedule", "Affected staff", CalendarDays]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)} style={{ background: tab === id ? C.panel : "transparent", color: tab === id ? C.text : C.dim, borderColor: tab === id ? C.line : "transparent" }} className="px-4 py-2 rounded-lg border text-sm font-medium flex items-center gap-2">
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: "rgba(216,80,63,0.1)", borderColor: "rgba(216,80,63,0.35)", color: C.red }} className="mb-4 p-3 rounded-lg border text-sm flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {/* ScheduleTab stays mounted so an uploaded schedule persists
          across tab switches. Its resolved shifts publish upstream via
          onShiftsResolved so Grid Status components cross-reference
          them. */}
      <div style={{ display: tab === "schedule" ? "block" : "none" }}>
        <ScheduleTab outages={outages} agents={roster.agents} rosterLoading={roster.loading} onShiftsResolved={setScheduleShifts} />
      </div>

      {tab === "grid" && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat icon={Activity} label="National grid" value={grid ? grid.status : "—"} tone={gridTone} sub={grid?.note} />
            <Stat icon={Zap} label="Districts dark now" value={DISTRICTS.filter((d) => byDistrict[d].worst === "active").length} tone={C.red} />
            <Stat icon={Clock} label="Districts scheduled" value={DISTRICTS.filter((d) => byDistrict[d].worst === "upcoming").length} tone={C.amber} />
            <Stat icon={Users} label="Staff located" value={roster.agents.length} tone={roster.agents.length ? C.mint : C.dim} />
          </div>

          <div className="mb-4">
            <div className="flex items-baseline justify-between mb-2 px-1">
              <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] uppercase tracking-widest">
                {selected ? `Filtered · ${selected}` : "Districts — tap to filter notices"}
                {scheduleShifts && scheduleShifts.length > 0 && (
                  <span style={{ color: C.mint }} className="ml-2">· schedule-matched</span>
                )}
              </div>
              {selected && (
                <button onClick={() => setSelected(null)} style={{ color: C.goldSoft, fontFamily: MONO }} className="text-[10px] hover:underline">
                  clear filter ×
                </button>
              )}
            </div>
            <DistrictGrid byDistrict={byDistrict} agents={roster.agents} outages={outages} shifts={scheduleShifts} selected={selected} onSelect={setSelected} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
            <div className="space-y-4">
              <AffectedStaffPanel agents={roster.agents} outages={outages} shifts={scheduleShifts} onOpenSchedule={() => setTab("schedule")} />
            </div>

            <div className="space-y-4">
              <Watchlist agents={roster.agents} outages={outages} />
              <WeatherPanel towns={weather.towns} error={weather.error} />
              <Panel
                title="Outage notices"
                right={
                  <div className="flex items-center gap-2">
                    {checked && <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{fmtTime(checked)} BZ</span>}
                    <button onClick={() => setShowLogForm(true)} title="Log ISP or manual outage" style={{ borderColor: C.line, color: C.goldSoft }} className="w-6 h-6 rounded border flex items-center justify-center hover:opacity-80">
                      <Plus size={12} />
                    </button>
                  </div>
                }
              >
                <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                  {loading && <div style={{ color: C.dim }} className="text-sm py-8 text-center">Searching BEL and Belize news outlets…</div>}
                  {!loading && visible.length === 0 && <div style={{ color: C.mint }} className="text-sm py-8 text-center">No outages on record{selected ? ` for ${selected}` : ""}.</div>}
                  {[...visible].sort((a, b) => (parseTs(a.start) || 0) - (parseTs(b.start) || 0)).map((o) => {
                    const st = statusOf(o), h = hoursUntil(o);
                    return (
                      <button key={o.id} onClick={() => setSelected(o.districts[0] || null)} className="w-full text-left p-3 rounded-lg border" style={{ background: st === "active" ? "rgba(216,80,63,0.07)" : "rgba(255,255,255,0.02)", borderColor: st === "active" ? "rgba(216,80,63,0.3)" : C.line }}>
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          <Pill tone={st === "active" ? "active" : "upcoming"}>{st === "active" ? "Dark now" : h < 24 ? `in ${Math.max(0, Math.round(h))}h` : "Scheduled"}</Pill>
                          {o.type === "load_shedding" && <Pill tone="gold">Load shed</Pill>}
                          {o.type === "isp_outage" && <Pill tone="quiet">ISP</Pill>}
                          {o.manual && <Pill tone="quiet">Manual · {o.source}</Pill>}
                        </div>
                        <div className="text-sm font-semibold">{o.districts.join(" · ") || "District unclear"}</div>
                        <div style={{ color: C.dim, fontFamily: MONO }} className="text-[11px] mt-1">{windowLabel(o)}</div>
                        {o.areaPlaces?.length > 0 && <div style={{ color: C.dim }} className="text-xs mt-1.5 leading-relaxed">{o.areaPlaces.slice(0, 6).map((p) => p.raw).join(", ")}{o.areaPlaces.length > 6 ? ` +${o.areaPlaces.length - 6}` : ""}</div>}
                        {o.cause && <div style={{ color: C.dim }} className="text-[11px] mt-1 italic">{o.cause}</div>}
                        {o.attachments?.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {o.attachments.map((a) => {
                              const url = `${API}/attachments/${encodeURIComponent(a.storedName)}`;
                              const isImg = a.mime?.startsWith("image/");
                              return isImg ? (
                                <a key={a.id} href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={a.filename} className="block">
                                  <img src={url} alt={a.filename} style={{ borderColor: C.line }} className="h-14 w-14 object-cover rounded border" />
                                </a>
                              ) : (
                                <a key={a.id} href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ borderColor: C.line, color: C.goldSoft }} className="text-[10px] px-2 py-1 rounded border flex items-center gap-1 hover:underline max-w-[180px]">
                                  <span className="truncate">{a.filename}</span>
                                  <ExternalLink size={9} className="shrink-0" />
                                </a>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 mt-2">
                          {o.published && <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">pub {o.published}</span>}
                          {o.source_url && (
                            <a href={o.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.goldSoft, fontFamily: MONO }} className="text-[10px] flex items-center gap-1 hover:underline">
                              {o.source} <ExternalLink size={10} />
                            </a>
                          )}
                          {o.manual && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!confirm("Delete this manual outage?")) return;
                                try { await deleteManualOutage(o.id); reload(true); }
                                catch (err) { alert(`Could not delete: ${err.message}`); }
                              }}
                              style={{ color: C.dim }}
                              className="text-[10px] flex items-center gap-1 hover:opacity-80"
                              title="Delete manual outage"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Panel>
              <SourcesPanel />
            </div>
          </div>
        </>
      )}

      {showLogForm && (
        <ManualOutageForm onClose={() => setShowLogForm(false)} onSaved={() => reload(true)} />
      )}

      <div style={{ color: C.dim, borderColor: C.line }} className="mt-5 pt-4 border-t text-[10px] leading-relaxed">
        BEL publishes no machine-readable outage feed. Notices are aggregated from BEL announcements and Belize news outlets via live search, so coverage lags real time and short-notice load shedding may not appear. Belize has had repeated CFE-linked crises since 2024 that read almost identically, so check the publication date on any notice before acting. Confirm anything staffing-critical against BEL at 0-800-BEL-CARE.
      </div>
    </div>
  );
}

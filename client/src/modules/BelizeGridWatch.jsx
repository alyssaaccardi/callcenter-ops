import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import {
  RefreshCw, Settings, AlertTriangle, Zap, Users, Clock, ExternalLink,
  Activity, Upload, Download, FileSpreadsheet, Radio, Map as MapIcon,
  CalendarDays, X, Moon, Eye, CheckCircle2,
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
const fmtDay = (d) => (d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Belize" }) : "");
const hrs = (ms) => Math.round((ms / 3600000) * 10) / 10;

function windowLabel(o) {
  const s = parseTs(o.start), e = parseTs(o.end);
  return s ? `${fmtDay(s)} · ${fmtTime(s)}–${e ? fmtTime(e) : "?"}` : "Time not stated";
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

  useEffect(() => { load(); }, [load]);
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
    const start = new Date(`${date}T${String(Math.floor(sMin / 60) % 24).padStart(2, "0")}:${String(sMin % 60).padStart(2, "0")}:00-06:00`);
    let end = new Date(`${date}T${String(Math.floor(eMin / 60) % 24).padStart(2, "0")}:${String(eMin % 60).padStart(2, "0")}:00-06:00`);
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
  const fill = (d) => { const s = byDistrict[d]?.worst; return s === "active" ? "url(#hatchRed)" : s === "upcoming" ? C.panelHi : C.panel; };
  const stroke = (d) => { const s = byDistrict[d]?.worst; return s === "active" ? C.red : s === "upcoming" ? C.amber : C.line; };

  // Cluster agents by town (one dot per town, sized by headcount).
  // Non-coord towns fall through silently — they still count in the
  // per-district total shown under the district label.
  const townClusters = useMemo(() => {
    const m = new Map();
    for (const a of agents || []) {
      const key = a.town && TOWN_COORDS[a.town] ? a.town : null;
      if (!key) continue;
      if (!m.has(key)) m.set(key, { count: 0, district: a.district });
      m.get(key).count++;
    }
    return [...m.entries()].map(([town, v]) => {
      const [lat, lon] = TOWN_COORDS[town];
      const [x, y] = svgFromLatLon(lat, lon);
      return { town, x, y, count: v.count, district: v.district };
    });
  }, [agents]);

  return (
    <svg viewBox="0 0 400 640" className="w-full h-full" role="img" aria-label="Belize districts and staff locations">
      <defs>
        <pattern id="hatchRed" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="7" height="7" fill="#3A1620" />
          <line x1="0" y1="0" x2="0" y2="7" stroke={C.red} strokeWidth="2.5" opacity="0.75" />
        </pattern>
      </defs>
      {DISTRICTS.map((d) => {
        const meta = DISTRICT_META[d], info = byDistrict[d] || {}, sel = selected === d;
        return (
          <g key={d} onClick={() => onSelect(sel ? null : d)} style={{ cursor: "pointer" }} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(sel ? null : d)}>
            <path d={meta.path} fill={fill(d)} stroke={sel ? C.gold : stroke(d)} strokeWidth={sel ? 2.6 : 1.4} strokeLinejoin="round" />
            {(meta.extra || []).map((p, i) => <path key={i} d={p} fill={fill(d)} stroke={sel ? C.gold : stroke(d)} strokeWidth="1.2" />)}
            {info.worst === "active" && (
              <circle cx={meta.label[0]} cy={meta.label[1] - 22} r="5" fill={C.red}>
                <animate attributeName="opacity" values="1;0.15;1" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
            <text x={meta.label[0]} y={meta.label[1]} textAnchor="middle" fill={info.worst ? C.text : C.dim} style={{ fontFamily: SANS, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em" }}>{d.toUpperCase()}</text>
            {info.staff > 0 && (
              <text x={meta.label[0]} y={meta.label[1] + 15} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 11 }} fill={info.worst === "active" ? C.red : info.worst ? C.amber : C.dim}>
                {info.staff} staff
              </text>
            )}
          </g>
        );
      })}
      {/* Staff-per-town dots. Always mint — they mean "people live here",
          never "outage". The district hatch behind them tells the outage
          story. Rendered after districts so they sit on top. Pointer events
          disabled so clicks still hit the district for filtering. */}
      {townClusters.map(({ town, x, y, count }) => (
        <g key={town} style={{ pointerEvents: "none" }}>
          <circle cx={x} cy={y} r={3 + Math.min(count, 6)} fill={C.mint} fillOpacity={0.85} stroke={C.ink} strokeWidth="1.2" />
          {count > 1 && (
            <text x={x} y={y + 3} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700 }} fill={C.ink}>
              {count}
            </text>
          )}
        </g>
      ))}
    </svg>
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

function ScheduleTab({ outages, agents, rosterLoading }) {
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
            <div style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] flex items-center gap-1 capitalize">
              {s.town || s.district} · {fmtDay(s.start)} {fmtTime(s.start)}–{fmtTime(s.end)}
              {fmtDay(s.start) !== fmtDay(s.end) && <Moon size={9} />}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div style={{ color: dim ? C.dim : s.pct >= 85 ? C.red : C.amber, fontFamily: MONO }} className="text-xs">{fmtTime(s.from)}–{fmtTime(s.to)}</div>
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
            <div style={{ color: none ? C.mint : live ? C.red : C.amber, fontFamily: MONO }} className="text-3xl font-bold leading-none">{g.headcount}</div>
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

/* ================================ app ================================= */
export default function BelizeGridWatch() {
  const [tab, setTab] = useState("grid");
  const [showCfg, setShowCfg] = useState(false);
  const [selected, setSelected] = useState(null);
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
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCfg((v) => !v)} style={{ borderColor: C.line, color: C.dim }} className="px-3 py-2 rounded-lg border text-xs flex items-center gap-2"><Settings size={13} /> Addresses</button>
          <button onClick={() => reload(true)} disabled={loading} style={{ background: C.gold, color: C.ink }} className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {loading ? "Checking" : "Refresh"}
          </button>
        </div>
      </div>

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
            <button onClick={roster.reload} style={{ background: C.panelHi, color: C.text, borderColor: C.line }} className="px-4 py-2 rounded-lg border text-sm">Reload addresses</button>
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
            background: liveOutages || severeWeather ? "rgba(216,80,63,0.08)" : "rgba(232,163,61,0.06)",
            borderColor: liveOutages || severeWeather ? "rgba(216,80,63,0.4)" : "rgba(232,163,61,0.35)",
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
          {severeWeather > 0 && (
            <span style={{ color: C.red, fontFamily: MONO }} className="text-xs flex items-center gap-1.5">
              <AlertTriangle size={12} /> {severeWeather} town{severeWeather !== 1 ? "s" : ""} · severe weather
            </span>
          )}
          {watchWeather > 0 && severeWeather === 0 && (
            <span style={{ color: C.amber, fontFamily: MONO }} className="text-xs flex items-center gap-1.5">
              <AlertTriangle size={12} /> {watchWeather} town{watchWeather !== 1 ? "s" : ""} · weather watch
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

      {tab === "schedule" ? (
        <ScheduleTab outages={outages} agents={roster.agents} rosterLoading={roster.loading} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat icon={Activity} label="National grid" value={grid ? grid.status : "—"} tone={gridTone} sub={grid?.note} />
            <Stat icon={Zap} label="Districts dark now" value={DISTRICTS.filter((d) => byDistrict[d].worst === "active").length} tone={C.red} />
            <Stat icon={Clock} label="Districts scheduled" value={DISTRICTS.filter((d) => byDistrict[d].worst === "upcoming").length} tone={C.amber} />
            <Stat icon={Users} label="Staff located" value={roster.agents.length} tone={roster.agents.length ? C.mint : C.dim} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
            <Panel
              title={selected ? `Filtered · ${selected}` : "Tap a district to filter"}
              right={
                <div className="flex items-center gap-3 flex-wrap">
                  {[["Dark now", C.red, "square"], ["Scheduled", C.amber, "square"], ["Clear", C.line, "square"], ["Staff", C.mint, "dot"]].map(([l, c, shape]) => (
                    <span key={l} style={{ color: C.dim, fontFamily: MONO }} className="text-[10px] flex items-center gap-1.5">
                      <span style={{ background: c }} className={shape === "dot" ? "w-2 h-2 rounded-full inline-block" : "w-2.5 h-2.5 rounded-sm inline-block"} /> {l}
                    </span>
                  ))}
                </div>
              }
            >
              <div className="h-[440px] md:h-[560px] flex items-center justify-center">
                <BelizeMap byDistrict={byDistrict} selected={selected} onSelect={setSelected} agents={roster.agents} />
              </div>
            </Panel>

            <div className="space-y-4">
              <Watchlist agents={roster.agents} outages={outages} />
              <WeatherPanel towns={weather.towns} error={weather.error} />
              <Panel title="Outage notices" right={checked && <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">{fmtTime(checked)} BZ</span>}>
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
                        </div>
                        <div className="text-sm font-semibold">{o.districts.join(" · ") || "District unclear"}</div>
                        <div style={{ color: C.dim, fontFamily: MONO }} className="text-[11px] mt-1">{windowLabel(o)}</div>
                        {o.areaPlaces?.length > 0 && <div style={{ color: C.dim }} className="text-xs mt-1.5 leading-relaxed">{o.areaPlaces.slice(0, 6).map((p) => p.raw).join(", ")}{o.areaPlaces.length > 6 ? ` +${o.areaPlaces.length - 6}` : ""}</div>}
                        <div className="flex items-center justify-between gap-2 mt-2">
                          {o.published && <span style={{ color: C.dim, fontFamily: MONO }} className="text-[10px]">pub {o.published}</span>}
                          {o.source_url && (
                            <a href={o.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.goldSoft, fontFamily: MONO }} className="text-[10px] flex items-center gap-1 hover:underline">
                              {o.source} <ExternalLink size={10} />
                            </a>
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

      <div style={{ color: C.dim, borderColor: C.line }} className="mt-5 pt-4 border-t text-[10px] leading-relaxed">
        BEL publishes no machine-readable outage feed. Notices are aggregated from BEL announcements and Belize news outlets via live search, so coverage lags real time and short-notice load shedding may not appear. Belize has had repeated CFE-linked crises since 2024 that read almost identically, so check the publication date on any notice before acting. Confirm anything staffing-critical against BEL at 0-800-BEL-CARE.
      </div>
    </div>
  );
}

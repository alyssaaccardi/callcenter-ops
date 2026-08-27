/**
 * Parser for https://www.bel.com.bz/PowerUpdates/
 *
 * BEL publishes a real HTML table — five columns:
 *   Districts Affected | Outage Date | Start Time | Estimated End Time | Areas To Be Affected
 *
 * The last cell packs structured fields in prose:
 *   "Load Center: Dangriga. Feeder: 2. Zone: 3 & 4 (portion).
 *    Areas to be affected: <list>. Outage type: Planned. Purpose of outage: <text>"
 *
 * This is authoritative and needs no model. Notices scraped from news coverage
 * are a fallback only.
 */

import { DISTRICTS, placeOf, norm } from "./client/src/lib/belize-places.mjs";

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const decode = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;|&rsquo;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Thursday 27 Aug 2026" / "27 August 2026" / "Sunday 30 Aug 2026" -> [y,m,d] */
export function parseDate(txt) {
  const m = String(txt).match(/(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  return [Number(m[3]), mon + 1, Number(m[1])];
}

/** "8:00AM" / "4:30 PM" / "12:00AM" -> minutes from midnight */
export function parseClock(txt) {
  const m = String(txt).match(/(\d{1,2})\s*:?\s*(\d{2})?\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + mi;
}

const iso = (ymd, mins) =>
  `${ymd[0]}-${String(ymd[1]).padStart(2, "0")}-${String(ymd[2]).padStart(2, "0")}` +
  `T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00-06:00`;

const addDayYmd = ([y, m, d]) => {
  const dt = new Date(Date.UTC(y, m - 1, d) + 86400000);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
};

/** Split an area list on commas/semicolons/"and", drop filler. */
function splitAreas(txt) {
  return String(txt)
    .split(/[;,]|\band\b|\bincluding\b/gi)
    .map((s) => s.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim())
    .map((s) => s.replace(/^(all areas from|entire|the)\s+/i, "").replace(/\.$/, "").trim())
    .filter((s) => s.length > 2 && !/^(surrounding areas?|areas?|surrounding communities)$/i.test(s));
}

/**
 * Pull the structured fields out of the "Areas To Be Affected" cell.
 * Handles "entire Toledo District except Monkey River, Bella Vista, ..."
 * which is district-wide WITH exclusions — flagging everyone would be wrong.
 */
export function parseAreasCell(cell) {
  const text = decode(cell);
  // BEL is inconsistent about periods between fields ("Punta Gorda  Feeder: ALL"),
  // so a field ends at a period OR at the next KNOWN label — not at any
  // capitalised word, which would truncate "Punta Gorda" to "Punta".
  const LABELS = "Load Center|Feeder|Zone|Areas? to be affected|Outage type|Purpose of outage";
  const field = (label) => {
    const m = text.match(new RegExp(`${label}\\s*:\\s*(.*?)(?:\\.|\\s+(?:${LABELS})\\s*:|$)`, "is"));
    return m ? m[1].trim() : null;
  };

  const loadCenter = field("Load Center");
  const feeder = field("Feeder");
  const zone = field("Zone");
  const outageType = field("Outage type");
  const purpose = (text.match(/Purpose of outage\s*:\s*(.*)$/i) || [])[1]?.trim() || null;

  let areaText = (text.match(/Areas? to be affected\s*:\s*([\s\S]*?)(?:Outage type\s*:|Purpose of outage\s*:|$)/i) || [])[1] || text;

  // "entire <X> District except A, B and C"
  let districtWide = false;
  let excludes = [];
  const wide = areaText.match(/entire\s+(.+?)\s+District(?:\s+except\s+([\s\S]*?))?(?:\.|$)/i);
  if (wide) {
    districtWide = true;
    if (wide[2]) excludes = splitAreas(wide[2]);
  }
  if (/\bcountry ?wide|nationwide|entire country|all districts\b/i.test(areaText)) districtWide = true;

  // Strip the "except ..." tail before listing areas, or the exempt villages
  // end up flagged as affected — the exact opposite of what BEL said.
  const affectedText = areaText.replace(/\bexcept\b[\s\S]*$/i, " ");
  const exSet = new Set(excludes.map((e) => norm(e)));
  const areas = splitAreas(affectedText)
    .filter((a) => !/^entire\b/i.test(a) && !/District$/i.test(a))
    .filter((a) => !exSet.has(norm(a)));

  return { loadCenter, feeder, zone, outageType, purpose, areas, excludes, districtWide, raw: areaText.trim() };
}

/** Districts named in column 1, e.g. "Portion of Stann Creek and Toledo District" */
export function parseDistricts(cell) {
  const t = decode(cell);
  return DISTRICTS.filter((d) => norm(t).includes(norm(d)));
}

/** Full page HTML -> outage objects. */
export function parsePowerUpdates(html) {
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const out = [];

  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 5) continue;

    const [cDist, cDate, cStart, cEnd, cAreas] = cells;
    if (/Districts?\s+Affected/i.test(decode(cDist))) continue; // header

    const ymd = parseDate(cDate);
    const sMin = parseClock(cStart);
    const eMin = parseClock(cEnd);
    if (!ymd || sMin == null) continue;

    const info = parseAreasCell(cAreas);
    const districts = parseDistricts(cDist);

    // A named area can reveal a district column 1 only said "Rural" about
    const areaPlaces = info.areas.map((a) => ({ raw: a, ...placeOf(a) }));
    for (const p of areaPlaces) if (p.district && !districts.includes(p.district)) districts.push(p.district);

    const start = iso(ymd, sMin);
    // Overnight rollover: keep -06:00 offset (all other timestamps use it too).
    const end = eMin == null ? null : iso(eMin <= sMin ? addDayYmd(ymd) : ymd, eMin);

    const type = /unplanned|emergency|unscheduled/i.test(info.outageType || "")
      ? "unplanned"
      : /load ?shed/i.test(info.raw + (info.purpose || ""))
      ? "load_shedding"
      : "planned";

    out.push({
      id: `bel-${ymd.join("")}-${sMin}-${norm(info.loadCenter || districts[0] || "x").replace(/ /g, "")}`,
      districts,
      areas: info.areas,
      areaPlaces,
      excludes: info.excludes,
      excludePlaces: info.excludes.map((a) => ({ raw: a, ...placeOf(a) })),
      district_wide: info.districtWide,
      start,
      end,
      type,
      cause: info.purpose ? info.purpose.slice(0, 120) : null,
      loadCenter: info.loadCenter,
      feeder: info.feeder,
      zone: info.zone,
      source: "BEL Power Updates",
      source_url: "https://www.bel.com.bz/PowerUpdates/",
      published: null,
    });
  }
  return out;
}

export async function fetchPowerUpdates() {
  const res = await fetch("https://www.bel.com.bz/PowerUpdates/", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RingSavvyGridWatch/1.0)" },
  });
  if (!res.ok) throw new Error(`BEL site returned ${res.status}`);
  const html = await res.text();
  const rows = parsePowerUpdates(html);

  // Fail loudly, not silently.
  //
  // Zero rows is a legitimate answer — BEL's table really is empty on quiet
  // days. But zero rows ALSO happens if they restructure their markup and the
  // parser stops matching, and the dashboard renders both as "all clear".
  // So: if the page still contains the table's own text but we parsed nothing,
  // that is a broken parser, not a quiet grid.
  const looksPopulated =
    /Areas?\s+To\s+Be\s+Affected/i.test(html) &&
    /(Load\s*Center|Outage\s+type)\s*:/i.test(html);

  if (!rows.length && looksPopulated) {
    throw new Error(
      "BEL PowerUpdates page has outage entries but none parsed — their markup " +
      "has probably changed. Check https://www.bel.com.bz/PowerUpdates/ manually " +
      "and update parsePowerUpdates()."
    );
  }
  return rows;
}

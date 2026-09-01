/**
 * Parser for https://puc.bz/publications/
 *
 * The PUC (Public Utilities Commission) publishes emergency declarations,
 * shortfall notices, and orders that BEL then acts on — usually a day or
 * two ahead of BEL's own PowerUpdates table. Example filings:
 *   - "BEL Declaration – Anticipated Emergency in Generation Services"
 *   - "BEL Provides Notice ... Material Shortfall in Generation Services"
 *   - "PUC's Decision and Order – COPA Tariff – ..."
 *
 * These are prose PDFs, not schedules, so we surface them as ADVISORIES
 * (banner-style notices with a title, date, and link) rather than timed
 * outage rows. Merging them into the outage list would pollute the
 * affected-staff math with fake nationwide 24/7 outages.
 *
 * Listing markup (WordPress theme):
 *   <article class="... category-electricity ...">
 *     <h2><a href="/slug/">Title</a></h2>
 *     <time datetime="2026-08-31T13:00:47-06:00">19 hours ago</time>
 *   </article>
 *
 * PDF URLs live only on the detail page, so we link to the detail page.
 */

const LISTING_URL = "https://puc.bz/publications/";

// Titles worth surfacing — grid-stress signals only. Routine tariff filings
// and licence renewals aren't staffing-relevant.
const RELEVANT_RE =
  /\b(emergency|declaration|shortfall|load[- ]?shedd|generation services|curtailment|blackout|outage)\b/i;

// PUC's archive goes back years. A "declaration" from 2 years ago is
// history, not signal. 60 days keeps this quarter's crisis visible without
// dragging in old CFE-linked incidents that read almost identically.
const MAX_AGE_DAYS = 60;

const decode = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8217;|&rsquo;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function parseListing(html) {
  const articles = [...String(html).matchAll(/<article[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi)];
  const out = [];
  for (const m of articles) {
    const classes = m[1];
    const body = m[2];
    if (!/\bcategory-electricity\b/.test(classes)) continue;

    const link = body.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const time = body.match(/<time[^>]*datetime="([^"]+)"/i);
    if (!time) continue;

    const href = link[1];
    const url = href.startsWith("http") ? href : `https://puc.bz${href}`;
    out.push({ url, title: decode(link[2]), published: time[1] });
  }
  return out;
}

export async function fetchPucAdvisories() {
  const res = await fetch(LISTING_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RingSavvyGridWatch/1.0)",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`PUC returned ${res.status}`);
  const html = await res.text();
  const all = parseListing(html);

  // Same "fail loudly" pattern as bel-scraper: if the page clearly has
  // article cards but we parsed nothing, the theme markup changed.
  if (!all.length && /w-grid-item/.test(html)) {
    throw new Error(
      "PUC publications page has entries but none parsed — their markup " +
      "has probably changed. Check https://puc.bz/publications/ manually " +
      "and update parseListing()."
    );
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  return all
    .filter((it) => RELEVANT_RE.test(it.title))
    .filter((it) => {
      const t = new Date(it.published).getTime();
      return Number.isFinite(t) && t > cutoff;
    })
    .map((it) => ({
      id: `puc-${it.url.replace(/[^a-z0-9]/gi, "").slice(-48)}`,
      title: it.title,
      published: it.published,
      source: "PUC",
      source_url: it.url,
    }));
}

/**
 * IODA (Georgia Tech) internet-outage detection for Belize.
 *
 * The Grid Watch board tracks BEL power outages. IODA gives us a
 * complementary country-wide *connectivity* signal — Google web-search
 * traffic vs. its SARIMA baseline and /24 subnets that stop responding
 * to ping. If both drop we know something bigger than a single ISP is
 * broken, even before Digi/Smart post to Facebook.
 *
 * Public API, no auth. Data is Copyright Georgia Tech Research Corp;
 * the country page (https://ioda.inetintel.cc.gatech.edu/country/BZ)
 * is what humans should look at when we surface a warning.
 */

const IODA_API = "https://api.ioda.inetintel.cc.gatech.edu/v2";
const WINDOW_SECONDS = 3 * 3600;                 // last 3h of signal
const SARIMA_BUCKETS_TO_CHECK = 4;               // ~2h of 30-min buckets
const PING_DROP_DEGRADED = 0.10;                 // 10% of /24s off = degraded
const PING_DROP_OUTAGE   = 0.20;                 // 20% off = outage

export async function fetchBzInternetStatus() {
  const until = Math.floor(Date.now() / 1000);
  const from  = until - WINDOW_SECONDS;
  const url = `${IODA_API}/signals/raw/country/BZ?from=${from}&until=${until}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`IODA ${res.status}`);
  const json = await res.json();
  const signals = json?.data?.[0] || [];

  const gtrSarima = signals.find((s) => s.datasource === "gtr-sarima");
  const gtrNorm   = signals.find((s) => s.datasource === "gtr-norm");
  const ping      = signals.find((s) => s.datasource === "ping-slash24");

  // gtr-sarima buckets are arrays of records: [{ agg_values: { observed, threshold, predicted } }]
  // IODA considers a bucket anomalous when observed < threshold.
  let anomalous = 0, buckets = 0;
  for (const bucket of (gtrSarima?.values || []).slice(-SARIMA_BUCKETS_TO_CHECK)) {
    if (!Array.isArray(bucket)) continue;
    for (const rec of bucket) {
      const a = rec?.agg_values;
      if (a?.observed == null || a?.threshold == null) continue;
      buckets++;
      if (a.observed < a.threshold) anomalous++;
    }
  }
  const anomalyRate = buckets ? anomalous / buckets : 0;

  // gtr-norm: 0..1 normalized traffic. Latest non-null value.
  const normVals = (gtrNorm?.values || []).filter((v) => typeof v === "number" && !isNaN(v));
  const latestNorm = normVals.length ? normVals[normVals.length - 1] : null;

  // ping-slash24: count of /24 subnets responding to ping. A drop from the
  // 3-hour peak = subnets going dark. Fall vs peak (not vs first bucket) so
  // an outage that started before our window still shows up.
  const pingVals = (ping?.values || []).filter((v) => typeof v === "number" && v > 0);
  const pingPeak    = pingVals.length ? Math.max(...pingVals) : null;
  const pingLatest  = pingVals.length ? pingVals[pingVals.length - 1] : null;
  const pingDropPct = (pingPeak && pingLatest) ? 1 - pingLatest / pingPeak : 0;

  let status = "normal";
  if (anomalyRate >= 0.75)        status = "outage";
  else if (anomalyRate >= 0.5)    status = "degraded";
  if (pingDropPct >= PING_DROP_OUTAGE)                        status = "outage";
  else if (pingDropPct >= PING_DROP_DEGRADED && status === "normal") status = "degraded";

  const parts = [];
  if (latestNorm != null)   parts.push(`web traffic ${Math.round(latestNorm * 100)}% of baseline`);
  if (pingDropPct >= 0.05)  parts.push(`${Math.round(pingDropPct * 100)}% of /24 subnets off`);
  if (anomalous && buckets) parts.push(`${anomalous}/${buckets} SARIMA buckets flagged`);
  const note = status === "normal" ? "" : (parts.join(" · ") || "IODA anomaly detected");

  return {
    status, note,
    signals: {
      gtrNorm: latestNorm,
      anomalousBuckets: anomalous,
      totalBuckets: buckets,
      pingPeak, pingLatest, pingDropPct,
    },
    source: "https://ioda.inetintel.cc.gatech.edu/country/BZ",
    checked: new Date().toISOString(),
  };
}

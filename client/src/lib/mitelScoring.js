// Efficiency-scoring helpers for the Mitel leaderboard.
//
// Designed so future metrics (QA, FCR, CSAT, schedule adherence, etc.) can be
// added by editing METRICS — `compute` and `score` will pick them up
// automatically as long as the source values are present on each agent row.

// Threshold for inclusion in the ranked leaderboard. ≥4 shift hours covers
// the standard part-time shift (4hr) and full-time (8hr) — anyone below
// likely worked a partial shift or didn't show up the full period.
export const SAMPLE_MINS = { shiftHours: 4, acdCalls: 50 };

// Each metric: where the value comes from, which direction is "good", its
// weight in the final 0-100 score, and an optional floor that prevents
// outlier values (e.g. <60s handle time) from skewing normalization.
export const METRICS = [
  { key: 'callsPerHour',      label: 'Calls Per Hour',  weight: 0.45, higherBetter: true,  format: 'num1' },
  { key: 'occupancy',         label: 'Occupancy %',     weight: 0.30, higherBetter: true,  format: 'pct'  },
  { key: 'acdHandlingAvgSec', label: 'Avg Handle Time', weight: 0.15, higherBetter: false, format: 'time', floorForNormalization: 60 },
  { key: 'availability',      label: 'Availability %',  weight: 0.10, higherBetter: true,  format: 'pct'  },
];

// Sanity check that weights sum to 1.0 (within rounding) — surfaces broken
// configuration before it silently miscalculates scores.
export function validateWeights(metrics = METRICS) {
  const sum = metrics.reduce((a, m) => a + (m.weight || 0), 0);
  return Math.abs(sum - 1) < 0.001;
}

function pctOfShift(timeSec, shiftSec) {
  if (!shiftSec || shiftSec <= 0) return 0;
  return Math.round((timeSec / shiftSec) * 1000) / 10;
}

// Augment a raw agent row with derived metrics. Pure — never mutates input.
export function computeDerived(a) {
  const shiftSec   = a.shiftDurationSec    || 0;
  const shiftHours = shiftSec / 3600;
  const acd        = a.acdCalls            || 0;
  const acdSec     = a.acdHandlingSec      || 0;
  const makeBusy   = pctOfShift(a.makeBusySec || 0, shiftSec);
  const dnd        = pctOfShift(a.dndSec     || 0, shiftSec);
  // Cap at 0% — Mitel sometimes shows summed time slightly > shift duration
  const availability = Math.max(0, 100 - makeBusy - dnd);
  // Occupancy: prefer the report's "ACD % of shift" field if it looks valid,
  // otherwise compute from handling time. Both should agree but reports drift.
  const occupancy = (a.acdPct && a.acdPct > 0) ? a.acdPct : pctOfShift(acdSec, shiftSec);

  return {
    ...a,
    shiftHours: Math.round(shiftHours * 100) / 100,
    callsPerHour: shiftHours > 0 ? Math.round((acd / shiftHours) * 100) / 100 : 0,
    occupancy,
    makeBusyPct: makeBusy,
    dndPct: dnd,
    availability: Math.round(availability * 10) / 10,
    // acdHandlingAvgSec already on the row from the parser
  };
}

// Returns true if the agent has enough data to be ranked.
export function meetsSampleThreshold(a, thresholds = SAMPLE_MINS) {
  return (a.shiftHours || 0) >= thresholds.shiftHours && (a.acdCalls || 0) >= thresholds.acdCalls;
}

// Min-max normalize a value to 0..100. Handles a "floor" (values at or below
// floor are clamped to the floor's normalized value, useful for guarding
// against suspiciously low handle times) and direction (higher- or
// lower-better).
function normalize(value, min, max, { higherBetter = true, floor = null } = {}) {
  if (max === min) return 50; // everyone equal → neutral score
  let v = value;
  if (floor != null && v < floor) v = floor;
  const ratio = (v - min) / (max - min);
  return higherBetter ? ratio * 100 : (1 - ratio) * 100;
}

// Compute 0..100 efficiency score for each agent. Normalization is performed
// against the supplied population (typically the ranked agents only — agents
// below sample threshold shouldn't pull the normalization bounds).
export function applyScores(rankedAgents, metrics = METRICS) {
  if (!rankedAgents.length) return [];

  // Find min/max for each metric across the ranked pool
  const bounds = {};
  for (const m of metrics) {
    let lo = Infinity, hi = -Infinity;
    for (const a of rankedAgents) {
      let v = a[m.key];
      if (v == null) continue;
      if (m.floorForNormalization != null && v < m.floorForNormalization) v = m.floorForNormalization;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    bounds[m.key] = { lo: isFinite(lo) ? lo : 0, hi: isFinite(hi) ? hi : 0 };
  }

  return rankedAgents.map(a => {
    let total = 0;
    const breakdown = {};
    for (const m of metrics) {
      const raw = a[m.key];
      if (raw == null) { breakdown[m.key] = 0; continue; }
      const n = normalize(raw, bounds[m.key].lo, bounds[m.key].hi, {
        higherBetter: m.higherBetter,
        floor: m.floorForNormalization,
      });
      breakdown[m.key] = Math.round(n * 10) / 10;
      total += n * m.weight;
    }
    return {
      ...a,
      efficiencyScore: Math.round(total * 10) / 10,
      scoreBreakdown: breakdown,
    };
  });
}

// One-shot: compute derived fields, split ranked vs low-sample, score the
// ranked pool, and return everything the dashboard needs.
export function processAgents(rawAgents, opts = {}) {
  const thresholds = opts.thresholds || SAMPLE_MINS;
  const metrics    = opts.metrics    || METRICS;

  const derived = (rawAgents || [])
    // Skip the trainees/system-account rows entirely — they'd just clutter both pools
    .filter(a => (a.shiftDurationSec || 0) > 0 || (a.acdCalls || 0) > 0)
    .map(computeDerived);

  const ranked    = derived.filter(a => meetsSampleThreshold(a, thresholds));
  const lowSample = derived.filter(a => !meetsSampleThreshold(a, thresholds));

  const scored = applyScores(ranked, metrics);

  // Exec-summary averages — across ranked agents only (low-sample would skew them)
  const avg = (key) => scored.length
    ? Math.round((scored.reduce((s, a) => s + (a[key] || 0), 0) / scored.length) * 10) / 10
    : 0;

  return {
    ranked: scored.sort((a, b) => b.efficiencyScore - a.efficiencyScore),
    lowSample,
    summary: {
      avgCallsPerHour: avg('callsPerHour'),
      avgOccupancy:    avg('occupancy'),
      avgHandleSec:    scored.length ? Math.round(scored.reduce((s, a) => s + (a.acdHandlingAvgSec || 0), 0) / scored.length) : 0,
      avgAvailability: avg('availability'),
      rankedCount:     scored.length,
      lowSampleCount:  lowSample.length,
    },
  };
}

// Build a quick lookup of efficiency scores keyed by extension — useful for
// week-over-week trend arrows.
export function scoreMapByExtension(rawAgents) {
  const { ranked } = processAgents(rawAgents);
  const map = new Map();
  for (const a of ranked) map.set(String(a.reportingId), a);
  return map;
}

// ─── Assignment engine ───────────────────────────────────────────────────────
// Distributes a round's briefs across the selected testers.
//
// Each tester carries a per-round quota (how many tests they are doing this
// round). Briefs are dealt out round-robin, weighted by remaining quota, so the
// load lands as evenly as the quotas allow rather than filling one tester's
// queue before starting the next.

function planAssignments({ briefs, testers }) {
  const roster = testers
    .map(t => ({ ...t, quota: Math.max(0, Number(t.quota) || 0), taken: 0 }))
    .filter(t => t.quota > 0);

  if (!roster.length) {
    return { plan: [], unassigned: briefs.map(b => b.id), reason: 'no testers with a quota above zero' };
  }

  const capacity = roster.reduce((s, t) => s + t.quota, 0);
  const plan = [];
  const unassigned = [];

  for (const brief of briefs) {
    // Pick whoever has the most quota left, breaking ties by who has taken
    // fewest so far. Without the tie-break the same tester wins every early
    // round and the spread is lumpy.
    const pick = roster
      .filter(t => t.taken < t.quota)
      .sort((a, b) => (b.quota - b.taken) - (a.quota - a.taken) || a.taken - b.taken)[0];
    if (!pick) { unassigned.push(brief.id); continue; }
    pick.taken += 1;
    plan.push({ brief_id: brief.id, tester_id: pick.id, queue_pos: pick.taken });
  }

  return {
    plan,
    unassigned,
    capacity,
    // Surfaced so the admin is told plainly rather than discovering it by
    // counting: more briefs than quota means some tests go untested.
    reason: unassigned.length
      ? `${unassigned.length} brief(s) exceed the total quota of ${capacity}`
      : null,
  };
}

module.exports = { planAssignments };

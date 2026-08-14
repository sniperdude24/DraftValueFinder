// The weekly roster report — the page you open on a Tuesday.
//
// The app was built to draft a team; this is the half that runs one. Four
// questions, in the order you actually ask them:
//
//   1. Who do I start?
//   2. Who on my roster is losing their job?
//   3. If I need a spot, who goes and who replaces them?
//   4. What breaks next week (byes, injuries)?
//
// Everything here is assembled from parts that already exist — computeTrend,
// rosterSummary, assignSlots, the sleeper signals — because the analysis was
// never the missing piece. What was missing is knowing WHO IS ACTUALLY
// AVAILABLE, which is why every section that touches the free-agent pool
// carries its age (see `poolStatus`).
//
// Two honesty rules run through it:
//
//   - A points drop with flat usage is NOISE, not a fading player. This is the
//     exact mirror of the unsustainable-spike guard the sleeper detector uses,
//     and it matters more here: dropping a good player after two quiet weeks
//     is the most expensive mistake this page could talk someone into.
//   - The app proposes a swap and shows both sides' evidence. It does not
//     decide, and it never pairs across positions.
import { rosterSummary } from './roster.js';
import { assignSlots, FLEX_ELIGIBLE } from './lineup.js';
import { computeTrend } from './trends.js';
import { freeAgentAge } from '../store/state.js';

// A free-agent list this old is worth warning about: waivers clear weekly, so
// anything past a week is likely to name someone already gone.
export const POOL_STALE_DAYS = 7;

// How close two projections have to be before the start/sit call is a
// judgment rather than an answer.
const CLOSE_CALL_POINTS = 2;

// Projected points under the user's own rules, set by scorePlayers. Falls back
// to nothing rather than to Sleeper's PPR figure — mixing the two silently
// would make a custom-scored lineup wrong in a way nobody could see.
const projPoints = p => p.projection?.points ?? null;

export function poolStatus(state, now = Date.now()) {
  const age = freeAgentAge(state, now);
  if (age == null) {
    return {
      known: false, age_days: null, stale: true,
      note: 'No free-agent list has been pasted, so the app does not know who is actually available. Pickup suggestions below are drawn from everyone it has no owner for, which is not the same thing.',
    };
  }
  const stale = age > POOL_STALE_DAYS;
  return {
    known: true,
    age_days: age,
    as_of: state.freeAgents.as_of,
    count: state.freeAgents.count ?? null,
    stale,
    note: stale
      ? `The free-agent list is ${age} days old. Waivers clear weekly, so some of these are probably gone — paste a fresh list before acting on it.`
      : `Free-agent list pasted ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}.`,
  };
}

// ---- 1. start / sit ----

// The lineup those projections support, plus the calls that are close enough
// to be yours rather than the app's.
export function startSit(myPlayers) {
  const ranked = [...myPlayers].sort((a, b) => (projPoints(b) ?? -1) - (projPoints(a) ?? -1));
  const { filled, bench } = assignSlots(ranked);

  const closeCalls = [];
  for (const slot of filled) {
    if (!slot.player) continue;
    const mine = projPoints(slot.player);
    if (mine == null) continue;
    const eligible = p => (slot.pos === 'FLEX' ? FLEX_ELIGIBLE.includes(p.position) : p.position === slot.pos);
    const challenger = bench.filter(eligible).map(p => ({ p, pts: projPoints(p) }))
      .filter(x => x.pts != null)
      .sort((a, b) => b.pts - a.pts)[0];
    if (challenger && mine - challenger.pts <= CLOSE_CALL_POINTS) {
      closeCalls.push({
        slot: slot.label,
        starting: row(slot.player),
        alternative: row(challenger.p),
        margin: Math.round((mine - challenger.pts) * 10) / 10,
      });
    }
  }

  // Anything the projections cannot speak to, said out loud rather than
  // ranked last and forgotten.
  const unprojected = ranked.filter(p => projPoints(p) == null).map(row);
  const flags = [];
  for (const slot of filled) {
    const p = slot.player;
    if (!p) { flags.push({ kind: 'empty_slot', slot: slot.label, text: `No player for ${slot.label}` }); continue; }
    if (p.meta?.injury_status) {
      flags.push({ kind: 'injury', slot: slot.label, id: p.id, text: `${p.name} is listed ${p.meta.injury_status}` });
    }
  }

  return {
    lineup: filled.map(s => ({ slot: s.label, position: s.pos, player: s.player ? row(s.player) : null })),
    bench: bench.map(row),
    close_calls: closeCalls,
    unprojected,
    flags,
    projected_total: Math.round(filled.reduce((t, s) => t + (projPoints(s.player ?? {}) ?? 0), 0) * 10) / 10,
  };
}

function row(p) {
  return {
    id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
    injury_status: p.meta?.injury_status ?? null,
    projected: projPoints(p),
    projected_ppr: p.projection?.pts_ppr ?? null,
  };
}

// ---- 2. fading ----

// A player is fading when snaps AND opportunities are both falling — the exact
// mirror of the sleeper signal, so the same evidence bar applies in both
// directions rather than a looser one for bad news.
export function fading(myPlayers) {
  const out = [];
  for (const p of myPlayers) {
    const t = computeTrend(p);
    if (!t.available) continue;

    // The mirror of trends.js's unsustainable_spike: points collapsed but
    // usage did not. That is variance, and saying so is the point.
    const pointsDropNoise = t.deltas.points != null && t.season.points > 0
      && t.deltas.points / t.season.points <= -0.35
      && t.directions.snaps !== 'falling' && t.directions.opportunities !== 'falling';

    if (pointsDropNoise) {
      out.push({
        ...row(p), state: 'noise',
        reason: 'Points are down sharply but snaps and opportunities are not — this is variance, not a lost role. Dropping here is usually the mistake.',
        evidence: evidenceOf(t),
      });
      continue;
    }
    if (t.usage === 'falling') {
      out.push({
        ...row(p), state: 'fading',
        reason: 'Snap share and opportunities are both falling over the last 3 games played',
        evidence: evidenceOf(t),
      });
    } else if (t.usage === 'mixed-down') {
      out.push({
        ...row(p), state: 'slipping',
        reason: t.directions.snaps === 'falling'
          ? 'Snap share falling; opportunities holding for now'
          : 'Opportunities falling; snap share holding for now',
        evidence: evidenceOf(t),
      });
    }
  }
  const rank = { fading: 0, slipping: 1, noise: 2 };
  return out.sort((a, b) => rank[a.state] - rank[b.state]);
}

const evidenceOf = t => ({
  snaps: { season: t.season.snap_pct, recent: t.recent.snap_pct, direction: t.directions.snaps },
  opportunities: { season: t.season.opportunities, recent: t.recent.opportunities, direction: t.directions.opportunities },
  points: { season: t.season.points, recent: t.recent.points },
  weeks: t.recent.weeks,
  basis: t.basis,
});

// ---- 3. drop → pickup ----

// Pair the weakest hold against the best available riser AT THE SAME POSITION.
// Never across positions: "drop your TE for this WR" is a roster-construction
// decision with consequences this function cannot see.
export function swaps(myPlayers, available, assessments, fadingRows, { limit = 4 } = {}) {
  const faded = fadingRows.filter(f => f.state !== 'noise');
  if (!faded.length) return [];

  const risersByPos = {};
  for (const p of available) {
    const a = assessments.get(p.id);
    if (!a || !['signal', 'emerging'].includes(a.signal.state)) continue;
    (risersByPos[p.position] ??= []).push({ p, a });
  }
  for (const list of Object.values(risersByPos)) {
    // Signal outranks emerging; the AI rank breaks the tie.
    list.sort((x, y) => (x.a.signal.state === y.a.signal.state
      ? (x.a.ai_rank ?? 1e9) - (y.a.ai_rank ?? 1e9)
      : x.a.signal.state === 'signal' ? -1 : 1));
  }

  const used = new Set();
  const out = [];
  for (const f of faded) {
    const candidates = (risersByPos[f.position] ?? []).filter(c => !used.has(c.p.id));
    if (!candidates.length) continue;
    const { p, a } = candidates[0];
    used.add(p.id);
    out.push({
      drop: f,
      add: {
        ...row(p),
        state: a.signal.state,
        reason: a.signal.reason,
        evidence: a.signal.evidence,
        context: a.signal.context,
        ai_rank: a.ai_rank,
        confidence: a.confidence,
      },
      note: 'Same position, so this is a like-for-like swap. Both sides show their evidence — the app is not ranking the decision for you.',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- the report ----

export function weeklyReport(players, assessments, state, {
  week = null, mode = 'draft', statsSeason = null, preview = false, now = Date.now(),
} = {}) {
  const mine = new Set(state.mine ?? []);
  const owned = new Set(Object.keys(state.owners ?? {}));
  const myPlayers = players.filter(p => mine.has(p.id));
  const available = players.filter(p => !owned.has(p.id));

  const fadingRows = fading(myPlayers);
  const roster = rosterSummary(myPlayers);

  return {
    mode,
    week,
    stats_season: statsSeason,
    // True when there is no live week and the page is showing a worked example
    // against completed games. Said on the page, not buried here.
    preview,
    pool: poolStatus(state, now),
    empty: myPlayers.length === 0,
    roster,
    start_sit: startSit(myPlayers),
    fading: fadingRows,
    swaps: swaps(myPlayers, available, assessments, fadingRows),
    available_count: available.length,
  };
}

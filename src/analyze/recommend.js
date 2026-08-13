// Draft-time recommendations: conservative, roster-aware, evidence-listed.
//
// A recommendation blends four transparent components:
//   1. AI assessment (market baseline adjusted for usage evidence)
//   2. Value vs the current pick (players falling past their ADP)
//   3. Roster fit (starter needs; never force a positional pick — warn instead)
//   4. Tier scarcity (last players before an expert-tier drop)
import { LEAGUE, rosterSummary } from './roster.js';

export function tierScarcity(availablePlayers) {
  // For each position: how many players remain in the best remaining
  // expert tier, and where the next tier begins.
  const byPos = {};
  for (const p of availablePlayers) {
    if (!p.expert?.tier) continue;
    (byPos[p.position] ??= []).push(p);
  }
  const out = {};
  for (const [pos, list] of Object.entries(byPos)) {
    list.sort((a, b) => a.expert.rank - b.expert.rank);
    const bestTier = list[0].expert.tier;
    const inTier = list.filter(p => p.expert.tier === bestTier);
    out[pos] = { best_tier: bestTier, remaining_in_tier: inTier.length, names: inTier.slice(0, 4).map(p => p.name) };
  }
  return out;
}

export function recommendations(players, assessments, state, { count = 8 } = {}) {
  const drafted = new Set(state.drafted ?? []);
  const mine = new Set(state.mine ?? []);
  const personal = state.personalRanks ?? {};
  const myPlayers = players.filter(p => mine.has(p.id));
  const roster = rosterSummary(myPlayers);
  const available = players.filter(p => !drafted.has(p.id));
  const currentPick = drafted.size + 1;
  const round = Math.floor(drafted.size / LEAGUE.teams) + 1;
  const scarcity = tierScarcity(available);

  const starterNeedPositions = new Set(roster.needs.filter(n => n.kind === 'starter').map(n => n.position));
  const roundsLeft = LEAGUE.rounds - roster.picksUsed;
  const positionWarnings = [];
  const starterSlotsUnfilled = roster.needs.reduce((a, n) => a + n.missing, 0);
  if (starterSlotsUnfilled >= roundsLeft && starterSlotsUnfilled > 0) {
    positionWarnings.push(`You have ${roundsLeft} picks left and ${starterSlotsUnfilled} unfilled starting slots (${roster.needs.map(n => `${n.missing} ${n.position}`).join(', ')}) — prioritize starters.`);
  } else {
    for (const n of roster.needs) {
      if (['K', 'DST'].includes(n.position)) continue;
      const sc = scarcity[n.position];
      if (sc && sc.remaining_in_tier <= 2) {
        positionWarnings.push(`Your roster still needs ${n.position} and only ${sc.remaining_in_tier} player(s) remain in the best available expert tier (${sc.names.join(', ')}). A tier drop is close.`);
      }
    }
  }

  const scored = available
    .filter(p => assessments.get(p.id)?.ai_rank != null)
    .map(p => {
      const a = assessments.get(p.id);
      // Value vs current pick: positive when the market would already have
      // taken this player (they're falling to you).
      const adpRank = p.adp?.rank ?? null;
      const value = adpRank != null ? currentPick - adpRank : null;
      const needBoost = starterNeedPositions.has(p.position)
        || (starterNeedPositions.has('FLEX') && LEAGUE.flexEligible.includes(p.position));
      // Late-round K/DST convention: don't recommend before the final rounds.
      const kdstPenalty = ['K', 'DST'].includes(p.position) && round < LEAGUE.rounds - 2 ? 1000 : 0;
      const draftScore = a.ai_rank_score
        - Math.max(0, Math.min(value ?? 0, 25)) * 0.8   // falling players get a push
        - (needBoost ? 6 : 0)
        + kdstPenalty;
      return { p, a, value, needBoost, draftScore };
    })
    .sort((x, y) => x.draftScore - y.draftScore);

  const recs = scored.slice(0, count).map(({ p, a, value, needBoost }) => {
    const why = [];
    const risk = [];
    const adpRank = p.adp?.rank, eRank = p.expert?.rank;

    if (value != null && value > 3) why.push(`Value: ADP says pick ~#${adpRank} (${p.adp.formatted}); still available at pick #${currentPick}`);
    else if (value != null && value < -12) risk.push(`Reach: ADP is #${adpRank}, ${Math.abs(value)} picks ahead of the current pick`);
    if (eRank != null && adpRank != null && adpRank - eRank >= 8) why.push(`Experts rank him #${eRank}, ${adpRank - eRank} spots ahead of his ADP (#${adpRank})`);
    for (const f of a.factors) {
      if (f.effect === 'up') why.push(f.text);
      else if (f.effect === 'down') risk.push(f.text);
      else if (f.effect === 'caution') risk.push(f.text);
    }
    if (needBoost) why.push(`Fills a remaining starting-roster need (${p.position})`);
    const sc = scarcity[p.position];
    if (sc && p.expert?.tier === sc.best_tier && sc.remaining_in_tier <= 3) {
      why.push(`One of the last ${sc.remaining_in_tier} players in expert tier ${sc.best_tier} at ${p.position}`);
    }
    if (p.bye != null && roster.byes[p.bye]?.length >= 2) {
      risk.push(`Shares week-${p.bye} bye with ${roster.byes[p.bye].join(' and ')}`);
    }
    if (personal[p.id] != null) {
      const diff = a.ai_rank - personal[p.id];
      why.push(`Your personal rank: #${personal[p.id]} (AI: #${a.ai_rank}${diff > 0 ? ` — you are ${diff} spots higher` : diff < 0 ? ` — you are ${-diff} spots lower` : ''})`);
    }
    if (a.signal.state === 'signal') why.push(`Sleeper signal active: ${a.signal.reason}`);
    else if (a.signal.state === 'emerging') why.push(`Emerging: ${a.signal.reason}`);

    return {
      id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
      adp_rank: adpRank ?? null, expert_rank: eRank ?? null, ai_rank: a.ai_rank,
      confidence: a.confidence, verdict: a.verdict, sleeper_state: a.signal.state,
      value_vs_pick: value,
      why: why.slice(0, 6),
      risk: risk.slice(0, 4),
    };
  });

  return {
    current_pick: currentPick,
    round,
    roster,
    scarcity,
    position_warnings: positionWarnings,
    recommendations: recs,
  };
}

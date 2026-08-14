// Team context — the fantasy ripple effect.
//
// A player's opportunity is a share of a fixed team pie, so changes are
// zero-sum: when someone leaves or gets hurt, their targets and touches go
// somewhere. This module reconstructs each team's pie from the game logs and
// shows how it is divided, how the division is moving, and which players are
// gaining alongside a teammate's absence.
//
// Two honesty rules baked in:
//  - Ripple links are OBSERVED CO-MOVEMENT, never claimed causation. We pair
//    a disruption with teammates whose usage rose and show both numbers.
//  - Our universe is the top ~250 fantasy players, so a team's tracked
//    players never account for the whole pie. The unaccounted remainder is
//    reported rather than hidden.
import { normTeam } from '../normalize/names.js';

const OUT_STATUSES = ['Out', 'IR', 'PUP', 'Sus', 'Doubtful'];

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const sumBy = (rows, pick) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r3 = v => (v == null ? null : Math.round(v * 1000) / 1000);

// Games a player logged for this specific team (handles mid-season trades:
// only the weeks actually played there count toward that team's pie).
const gamesForTeam = (p, team) => (p.games ?? []).filter(g => normTeam(g.stats_team) === team);

// Reconstruct the team's weekly target total. Any player's targets divided
// by their target share yields the team total for that week; the median
// across players absorbs rounding noise in the published share.
export function teamWeeklyTargets(players, team) {
  const byWeek = new Map();
  for (const p of players) {
    for (const g of gamesForTeam(p, team)) {
      if (g.targets > 0 && g.target_share > 0.03) {
        if (!byWeek.has(g.week)) byWeek.set(g.week, []);
        byWeek.get(g.week).push(g.targets / g.target_share);
      }
    }
  }
  const out = new Map();
  for (const [week, estimates] of byWeek) out.set(week, median(estimates));
  return out;
}

// Share of the team's targets across a specific set of weeks. Computed from
// TOTALS over those weeks (not an average of per-game shares), so a player
// who missed games correctly shows a smaller share of the window.
function distribution(players, team, weeks, weeklyTargets) {
  const weekSet = new Set(weeks);
  const teamTargets = weeks.reduce((t, w) => t + (weeklyTargets.get(w) ?? 0), 0);

  const rows = players.map(p => {
    const games = gamesForTeam(p, team).filter(g => weekSet.has(g.week));
    if (!games.length) return null;
    const targets = sumBy(games, g => g.targets);
    const carries = sumBy(games, g => g.carries);
    if (!targets && !carries) return null;
    return {
      id: p.id, name: p.name, position: p.position,
      still_on_team: p.team === team,
      injury_status: p.meta?.injury_status ?? null,
      games: games.length,
      targets,
      carries,
      targets_pg: r1(targets / games.length),
      carries_pg: r1(carries / games.length),
      target_share: teamTargets > 0 ? r3(targets / teamTargets) : null,
      air_yards: sumBy(games, g => g.receiving_air_yards),
      ppr_pg: r1(sumBy(games, g => g.fantasy_points) / games.length),
    };
  }).filter(Boolean);

  const trackedCarries = sumBy(rows, r => r.carries);
  for (const r of rows) r.carry_share = trackedCarries > 0 ? r3(r.carries / trackedCarries) : null;

  return {
    weeks,
    team_targets: Math.round(teamTargets),
    team_targets_pg: weeks.length ? r1(teamTargets / weeks.length) : null,
    tracked_carries: trackedCarries,
    tracked_carries_pg: weeks.length ? r1(trackedCarries / weeks.length) : null,
    // How much of the pie our top-250 universe actually accounts for.
    accounted_target_share: teamTargets > 0 ? r3(sumBy(rows, r => r.targets) / teamTargets) : null,
    rows: rows.sort((a, b) => (b.target_share ?? 0) - (a.target_share ?? 0) || b.carries - a.carries),
  };
}

// Red-zone distribution. Unlike the target pie, this needs no
// reconstruction: the play-by-play source counts every red-zone play in the
// league, so `teamRzWeekly` is a complete, exact denominator and the shares
// below sum to the whole pie rather than to our tracked subset.
function redZoneDistribution(players, team, weeks, teamRzWeekly) {
  if (!teamRzWeekly) return null;
  const weekSet = new Set(weeks);
  const team_rz_targets = weeks.reduce((t, w) => t + (teamRzWeekly[w]?.rz_targets ?? 0), 0);
  const team_rz_carries = weeks.reduce((t, w) => t + (teamRzWeekly[w]?.rz_carries ?? 0), 0);
  const team_gl_targets = weeks.reduce((t, w) => t + (teamRzWeekly[w]?.gl_targets ?? 0), 0);
  const team_gl_carries = weeks.reduce((t, w) => t + (teamRzWeekly[w]?.gl_carries ?? 0), 0);
  const team_rz_opportunities = team_rz_targets + team_rz_carries;
  const team_gl_opportunities = team_gl_targets + team_gl_carries;

  const rows = players.map(p => {
    const games = gamesForTeam(p, team).filter(g => weekSet.has(g.week));
    if (!games.length) return null;
    const rz_targets = sumBy(games, g => g.rz_targets);
    const rz_carries = sumBy(games, g => g.rz_carries);
    const gl_opportunities = sumBy(games, g => g.gl_targets) + sumBy(games, g => g.gl_carries);
    const rz_opportunities = rz_targets + rz_carries;
    if (!rz_opportunities) return null;
    return {
      id: p.id, name: p.name, position: p.position,
      still_on_team: p.team === team,
      injury_status: p.meta?.injury_status ?? null,
      games: games.length,
      rz_targets, rz_carries, rz_opportunities, gl_opportunities,
      rz_tds: sumBy(games, g => g.rz_tds),
      rz_opportunity_share: team_rz_opportunities > 0 ? r3(rz_opportunities / team_rz_opportunities) : null,
      gl_opportunity_share: team_gl_opportunities > 0 ? r3(gl_opportunities / team_gl_opportunities) : null,
    };
  }).filter(Boolean).sort((a, b) => b.rz_opportunities - a.rz_opportunities);

  return {
    weeks,
    team_rz_targets, team_rz_carries, team_rz_opportunities,
    team_gl_opportunities,
    team_rz_opportunities_pg: weeks.length ? r1(team_rz_opportunities / weeks.length) : null,
    // Reported for symmetry with the target pie, but this one is exact by
    // construction: it only falls short if a red-zone touch went to a player
    // outside our universe, which the number then makes visible.
    accounted_share: team_rz_opportunities > 0
      ? r3(sumBy(rows, r => r.rz_opportunities) / team_rz_opportunities) : null,
    rows,
  };
}

export function buildTeamContext(allPlayers, teamCode, { lastN = 3, teamRedzone = null } = {}) {
  const team = normTeam(teamCode);

  // Anyone who logged a game for this team, plus anyone currently rostered
  // there (arrivals with no games yet for this team).
  const contributors = allPlayers.filter(p => p.team === team || gamesForTeam(p, team).length);
  const weeks = [...new Set(contributors.flatMap(p => gamesForTeam(p, team).map(g => g.week)))].sort((a, b) => a - b);
  const weeklyTargets = teamWeeklyTargets(contributors, team);

  const season = distribution(contributors, team, weeks, weeklyTargets);
  const recent = distribution(contributors, team, weeks.slice(-lastN), weeklyTargets);
  const redzone = redZoneDistribution(contributors, team, weeks, teamRedzone);
  const redzone_recent = redZoneDistribution(contributors, team, weeks.slice(-lastN), teamRedzone);

  // Share movement: recent window vs the full window, in percentage points.
  const seasonById = new Map(season.rows.map(r => [r.id, r]));
  const movement = recent.rows.map(r => {
    const s = seasonById.get(r.id);
    const from = s?.target_share ?? null, to = r.target_share ?? null;
    return {
      id: r.id, name: r.name, position: r.position, still_on_team: r.still_on_team,
      target_share_from: from, target_share_to: to,
      target_share_delta: from != null && to != null ? r3(to - from) : null,
      carries_pg_from: s?.carries_pg ?? null, carries_pg_to: r.carries_pg,
    };
  }).filter(m => m.target_share_delta != null || (m.carries_pg_to ?? 0) > 0)
    .sort((a, b) => (b.target_share_delta ?? 0) - (a.target_share_delta ?? 0));

  // Roster churn: production that left the building, and mouths that arrived.
  const departed = season.rows
    .filter(r => !r.still_on_team)
    .map(r => ({ ...r, now_with: allPlayers.find(p => p.id === r.id)?.team ?? null }));
  const arrived = contributors
    .filter(p => p.team === team && !gamesForTeam(p, team).length && (p.games ?? []).length)
    .map(p => ({ id: p.id, name: p.name, position: p.position, came_from: normTeam(p.stats_team) }));

  const vacated_target_share = departed.length
    ? r3(sumBy(departed, d => d.target_share)) : 0;
  const vacated_carries = sumBy(departed, d => d.carries);

  // Vacated scoring chances — the most fantasy-relevant vacancy of all,
  // since red-zone touches convert to touchdowns at many times the rate of
  // touches between the 20s.
  const departedIds = new Set(departed.map(d => d.id));
  const vacated_rz_opportunity_share = redzone
    ? r3(sumBy(redzone.rows.filter(r => departedIds.has(r.id)), r => r.rz_opportunity_share)) : null;

  // Ripple: pair each disruption with teammates whose usage rose. Observed
  // co-movement only — the numbers are shown so the user can judge.
  const disruptions = [
    ...contributors.filter(p => p.team === team && OUT_STATUSES.includes(p.meta?.injury_status))
      .map(p => ({ id: p.id, name: p.name, position: p.position, reason: `listed ${p.meta.injury_status}` })),
    ...departed.map(d => ({ id: d.id, name: d.name, position: d.position, reason: `left for ${d.now_with ?? 'another team'}`, vacated_target_share: d.target_share, vacated_carries: d.carries })),
  ];

  const risers = movement.filter(m => m.still_on_team && (
    (m.target_share_delta ?? 0) >= 0.03 ||
    ((m.carries_pg_to ?? 0) - (m.carries_pg_from ?? 0)) >= 2
  ));

  const ripple = disruptions.map(d => ({
    disrupted: d,
    beneficiaries: risers
      .filter(r => r.id !== d.id)
      .slice(0, 5)
      .map(r => ({
        id: r.id, name: r.name, position: r.position,
        target_share_from: r.target_share_from, target_share_to: r.target_share_to,
        carries_pg_from: r.carries_pg_from, carries_pg_to: r.carries_pg_to,
      })),
  }));

  return {
    team,
    weeks,
    games: weeks.length,
    season,
    recent,
    redzone,
    redzone_recent,
    movement,
    roster_changes: { departed, arrived, vacated_target_share, vacated_carries, vacated_rz_opportunity_share },
    ripple,
  };
}

// Lightweight index for the team picker.
export function teamSummaries(allPlayers) {
  const teams = new Map();
  for (const p of allPlayers) {
    if (!p.team) continue;
    if (!teams.has(p.team)) teams.set(p.team, { team: p.team, players: 0, injured: 0, incoming: 0 });
    const t = teams.get(p.team);
    t.players++;
    if (OUT_STATUSES.includes(p.meta?.injury_status)) t.injured++;
    if (p.changed_team) t.incoming++;
  }
  return [...teams.values()].sort((a, b) => a.team.localeCompare(b.team));
}

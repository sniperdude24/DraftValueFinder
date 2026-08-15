// Does the sleeper signal actually predict anything?
//
// The app's whole premise is catching a riser before the market reprices him.
// That is a testable claim, and until it is tested it is just a claim — so
// this module replays a completed season and measures it.
//
// THE ONE PROPERTY THAT MATTERS: NO LOOKAHEAD.
// The signal at cut point N is computed from games 1..N and nothing else. Let
// one future game leak in and the backtest becomes a spectacular, meaningless
// success — the model would be "predicting" results it was shown. Every cut
// builds a truncated copy of the player, and `noLookahead` below is the only
// place games are sliced, so there is one line to get right and one to test.
//
// TWO DELIBERATE EXCLUSIONS, both to avoid measuring the wrong thing:
//
//   1. CONTEXT IS OFF. computeSignal can promote 'emerging' to 'signal' on
//      supporting context — a teammate listed Out, a depth-chart position.
//      Those come from Sleeper's CURRENT data. Feeding today's injury report
//      into a replay of last season is an anachronism that would flatter the
//      result, so the backtest passes an empty universe and measures the pure
//      usage signal. The page says so.
//   2. THE HEADLINE IS THE DELTA, not raw forward points. Signals fire on good
//      players getting busier, so comparing their raw output to everyone
//      else's mostly measures talent. Forward-minus-trailing controls for the
//      player's own level and isolates what the signal claims: that usage
//      rising now means production rising next.
import { computeTrend } from './trends.js';
import { computeSignal } from './signals.js';

// computeTrend's own full-sample threshold: fewer than four games played and
// it has nothing to compare a last-3 window against.
export const MIN_GAMES = 4;
export const DEFAULT_HORIZON = 4;

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const pointsOf = games => games.map(g => g.fantasy_points).filter(v => v != null);

// The ONLY place a player's game log is cut. Everything the signal sees comes
// from here, so "could the future have leaked in?" is a question about one
// function rather than about the whole module.
function noLookahead(player, gamesKnown) {
  return { ...player, games: player.games.slice(0, gamesKnown) };
}

/**
 * Replay a completed season, one cut point per player per game played.
 *
 * @returns { horizon, min_games, cuts, groups, spike, caveats }
 *   `groups` is keyed by signal state; each carries n, the mean trailing and
 *   forward points per game, and the delta between them.
 */
export function backtest(players, { horizon = DEFAULT_HORIZON, minGames = MIN_GAMES } = {}) {
  const observations = [];

  for (const player of players ?? []) {
    const games = player.games ?? [];
    // Cut after `known` games, requiring a FULL horizon afterwards — a
    // half-length forward window would make late-season cuts look different
    // for a reason that has nothing to do with the signal.
    for (let known = minGames; known + horizon <= games.length; known++) {
      const past = noLookahead(player, known);
      const forward = games.slice(known, known + horizon);

      const trailingPts = pointsOf(past.games);
      const forwardPts = pointsOf(forward);
      if (!trailingPts.length || forwardPts.length < horizon) continue;

      const trend = computeTrend(past);
      if (!trend.available) continue;
      // Empty universe: no context factors. See the note at the top.
      const signal = computeSignal(past, [], trend);

      const trailing = mean(trailingPts);
      const fwd = mean(forwardPts);
      observations.push({
        id: player.id,
        name: player.name,
        position: player.position,
        after_week: past.games[past.games.length - 1].week,
        games_known: known,
        state: signal.state,
        spike: !!trend.flags.unsustainable_spike,
        trailing,
        // The last-3 level the trend engine was looking at. For the spike
        // claim this is the right baseline, not the season average — see
        // `delta_vs_recent` below.
        recent: trend.recent.points,
        forward: fwd,
        delta: fwd - trailing,
      });
    }
  }

  const summarize = rows => {
    const withRecent = rows.filter(r => r.recent != null);
    return {
      n: rows.length,
      players: new Set(rows.map(r => r.id)).size,
      trailing_pg: r2(mean(rows.map(r => r.trailing))),
      recent_pg: r2(mean(withRecent.map(r => r.recent))),
      forward_pg: r2(mean(rows.map(r => r.forward))),
      // The headline for the SIGNAL claim: did the group score more after the
      // cut than its season form to date? That is what "usage rising now"
      // is supposed to buy.
      delta: r2(mean(rows.map(r => r.delta))),
      // The headline for the SPIKE claim, which is a different assertion:
      // the engine says a recent points burst without usage growth will not
      // hold. Testing that against the season average would be testing the
      // wrong thing — the burst IS in the season average. It has to be
      // measured against the burst itself, so a correct rejection shows up
      // here as a NEGATIVE number.
      delta_vs_recent: r2(mean(withRecent.map(r => r.forward - r.recent))),
    };
  };

  const groups = {
    signal: summarize(observations.filter(o => o.state === 'signal')),
    emerging: summarize(observations.filter(o => o.state === 'emerging')),
    none: summarize(observations.filter(o => o.state === 'none')),
  };

  // A separate claim, worth its own measurement: the engine REJECTS a points
  // spike that usage does not support, calling it noise. If those players go
  // on to sustain, the rejection is costing real production.
  const spike = summarize(observations.filter(o => o.spike));

  const lift = groups.signal.delta != null && groups.none.delta != null
    ? r2(groups.signal.delta - groups.none.delta) : null;

  return {
    horizon,
    min_games: minGames,
    cuts: observations.length,
    groups,
    spike,
    lift,
    // Rendered next to the numbers, not buried in a footnote. A backtest that
    // does not state what would make it wrong is advertising.
    caveats: [
      'The player universe was selected by 2026 consensus rank, which was set after the 2025 season finished. Players who collapsed may not be in it at all, so this reads optimistically — it is a test of the signal within a surviving population, not of the signal in the wild.',
      'Supporting context (teammate injuries, depth chart) is excluded: that data is current, and applying it to a replay of a finished season would be an anachronism.',
      'Points are scored under your current rules, so these figures move when you change scoring. That is correct, but it means the backtest is not a fixed historical fact.',
      'Cut points from the same player are not independent observations — one durable role change produces several. The player count beside each n is the honest sample size.',
    ],
  };
}

// ---- grading what the app actually said ----

// The accountability log records the app's calls. Grading them needs games
// played AFTER the call, which is a different thing from the backtest: the
// backtest asks whether the method works, this asks whether it worked for you.
//
// Every entry needs the week it was made in. Entries written before that was
// logged cannot be placed on a timeline and are reported as ungradeable rather
// than being assigned a week by guesswork.
export function gradeLog(entries, players, { horizon = DEFAULT_HORIZON } = {}) {
  const byId = new Map((players ?? []).map(p => [p.id, p]));
  const recs = (entries ?? []).filter(e => e.player_id);

  const graded = [];
  let noWeek = 0, noGames = 0, notFound = 0;

  for (const e of recs) {
    const p = byId.get(e.player_id);
    if (!p) { notFound++; continue; }
    if (e.week == null || e.season == null) { noWeek++; continue; }
    // Only games in the season the call was made about, after that week.
    if (p.stats_season !== e.season) { noGames++; continue; }
    const forward = (p.games ?? []).filter(g => g.week > e.week).slice(0, horizon);
    const pts = pointsOf(forward);
    if (!pts.length) { noGames++; continue; }

    const before = pointsOf((p.games ?? []).filter(g => g.week <= e.week));
    graded.push({
      at: e.at,
      week: e.week,
      player: e.player,
      position: e.position,
      state: e.sleeper_state ?? 'none',
      ai_rank: e.ai_rank ?? null,
      confidence: e.confidence ?? null,
      games_after: pts.length,
      trailing_pg: r2(mean(before)),
      forward_pg: r2(mean(pts)),
      delta: before.length ? r2(mean(pts) - mean(before)) : null,
    });
  }

  return {
    available: graded.length > 0,
    horizon,
    graded,
    summary: graded.length ? {
      n: graded.length,
      forward_pg: r2(mean(graded.map(g => g.forward_pg))),
      delta: r2(mean(graded.filter(g => g.delta != null).map(g => g.delta))),
    } : null,
    pending: { total: recs.length, no_week: noWeek, no_games_yet: noGames, player_not_found: notFound },
    reason: graded.length ? null
      : noWeek === recs.length
        ? 'Every logged recommendation predates the week being recorded on the log, so none can be placed on a timeline. Calls made from now on will be gradeable.'
        : 'No games have been played since these recommendations were made. This fills in once the season starts.',
  };
}

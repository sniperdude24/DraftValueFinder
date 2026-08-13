// Season/mode resolution — the single source of truth for whether the app
// is in draft mode (pre-season: analyze last season's stats for the draft)
// or season mode (regular/post season: analyze the current season, waiver
// radar). Pure so it can be tested against every state combination.

// sleeperState: data/raw/sleeper_state.json ({ season, season_type, week })
// currentSeasonStatsAvailable: do we have this season's weekly stats on disk?
export function resolveSeason(sleeperState, currentSeasonStatsAvailable) {
  const season = Number(sleeperState?.season ?? new Date().getFullYear());
  const inSeason = ['regular', 'post'].includes(sleeperState?.season_type);
  if (inSeason && currentSeasonStatsAvailable) {
    return {
      mode: 'season',
      season,
      stats_season: season,
      baseline_season: season - 1,
      week: Number(sleeperState?.week) || null,
    };
  }
  return {
    mode: 'draft',
    season,
    stats_season: season - 1,
    baseline_season: null,
    week: null,
  };
}

// Market disagreement: where the AI assessment, ADP, and expert consensus
// point in different directions — and why.
import { assessAll } from './score.js';

export function marketComparison(players, assessments = null) {
  const assess = assessments ?? assessAll(players);
  const rows = players.map(p => {
    const a = assess.get(p.id);
    const adpRank = p.adp?.rank ?? null;
    const expertRank = p.expert?.rank ?? null;
    const aiRank = a.ai_rank;
    const tradeRank = p.trade_market?.rank ?? null;
    return {
      id: p.id, name: p.name, position: p.position, team: p.team, bye: p.bye,
      adp_rank: adpRank, adp: p.adp?.overall ?? null,
      expert_rank: expertRank,
      trade_rank: tradeRank,
      ai_rank: aiRank,
      ai_verdict: a.verdict,
      confidence: a.confidence,
      sleeper_state: a.signal.state,
      // Positive delta = AI is higher on the player than that market source.
      ai_vs_adp: adpRank != null && aiRank != null ? adpRank - aiRank : null,
      ai_vs_expert: expertRank != null && aiRank != null ? expertRank - aiRank : null,
      ai_vs_trade: tradeRank != null && aiRank != null ? tradeRank - aiRank : null,
      expert_vs_adp: adpRank != null && expertRank != null ? adpRank - expertRank : null,
      factors: a.factors,
    };
  });

  const meaningful = rows
    .filter(r => r.ai_vs_adp != null || r.ai_vs_expert != null || r.ai_vs_trade != null)
    .map(r => ({ ...r, max_disagreement: Math.max(Math.abs(r.ai_vs_adp ?? 0), Math.abs(r.ai_vs_expert ?? 0), Math.abs(r.ai_vs_trade ?? 0), Math.abs(r.expert_vs_adp ?? 0)) }))
    .sort((x, y) => y.max_disagreement - x.max_disagreement);

  return { rows, biggest: meaningful.slice(0, 40) };
}

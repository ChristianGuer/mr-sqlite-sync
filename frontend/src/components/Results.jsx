function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

export default function Results({ recommendations, globalWR }) {
  if (!recommendations) return null;

  return (
    <div className="results">
      <div className="section-label" style={{ marginBottom: 16 }}>
        Recommended picks &mdash; your overall WR: {globalWR}%
      </div>
      {recommendations.map((r, i) => (
        <div key={r.hero_id} className="result-card">
          <div className={`result-rank ${i === 0 ? 'top' : ''}`}>#{i + 1}</div>
          <div>
            <div className="result-name">{capitalize(r.hero_name)}</div>
            <div className="result-bar-wrap">
              <div className="result-bar" style={{ width: `${r.score}%` }} />
            </div>
            <div className="result-meta">
              <span className="tag">{r.wins}W / {r.games - r.wins}L</span>
              <span className="tag">{r.personal_wr}% WR</span>
              <span className="tag">{r.matchup_games} matchup game{r.matchup_games !== 1 ? 's' : ''}</span>
              {r.low_data && <span className="tag warn">⚠ low data</span>}
            </div>
          </div>
          <div className="result-score">{r.score}</div>
        </div>
      ))}
    </div>
  );
}

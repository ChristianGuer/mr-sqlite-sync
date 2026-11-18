import { useState, useEffect, useRef } from 'react';
import HeroGrid from './components/HeroGrid';
import Results from './components/Results';

const API = 'http://localhost:3001';

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

export default function App() {
  const [heroes, setHeroes] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [recommendations, setRecommendations] = useState(null);
  const [globalWR, setGlobalWR] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const resultsRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/heroes`)
      .then(r => r.json())
      .then(data => setHeroes(data.heroes))
      .catch(() => setError('Could not reach server — is node server.js running?'));
  }, []);

  function toggle(heroId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(heroId)) {
        next.delete(heroId);
      } else {
        if (next.size >= 6) return prev;
        next.add(heroId);
      }
      return next;
    });
  }

  function clear() {
    setSelected(new Set());
    setRecommendations(null);
    setError(null);
  }

  async function getRecommendations() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/recommendations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enemyIds: [...selected] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRecommendations(data.recommendations);
      setGlobalWR(data.global_wr);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const selectedNames = [...selected].map(id => {
    const h = heroes.find(h => h.hero_id === id);
    return h ? capitalize(h.name) : null;
  }).filter(Boolean);

  return (
    <>
      <header>
        <h1>Marvel Rivals <span>Counter Pick</span></h1>
      </header>

      <div className="container">
        {error && !heroes.length ? (
          <div className="error" style={{ marginTop: 32 }}>{error}</div>
        ) : (
          <>
            <div className="section-label">Select enemy heroes (up to 6)</div>
            <HeroGrid heroes={heroes} selected={selected} onToggle={toggle} />

            <div className="action-bar">
              <div className="selected-count">
                Selected: <span>{selected.size}</span> / 6
              </div>
              <div className="selected-names">
                {selectedNames.join(' · ') || '—'}
              </div>
              <button type="button" className="btn-clear" onClick={clear}>
                Clear
              </button>
              <button
                type="button"
                onClick={getRecommendations}
                disabled={selected.size === 0 || loading}
              >
                {loading ? 'Calculating…' : 'Get Picks'}
              </button>
            </div>

            {error && <div className="error" style={{ marginTop: 24 }}>{error}</div>}

            <div ref={resultsRef}>
              <Results recommendations={recommendations} globalWR={globalWR} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

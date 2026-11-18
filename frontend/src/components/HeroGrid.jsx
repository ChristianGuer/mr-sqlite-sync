const ROLES = ['Vanguard', 'Duelist', 'Strategist'];

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

export default function HeroGrid({ heroes, selected, onToggle }) {
  const byRole = Object.fromEntries(ROLES.map(r => [r, []]));
  for (const h of heroes) {
    (byRole[h.role] ??= []).push(h);
  }

  return (
    <div>
      {ROLES.map(role => (
        <div key={role} className="role-group">
          <div className={`role-title ${role}`}>{role}</div>
          <div className="hero-grid">
            {byRole[role].map(h => {
              const isSelected = selected.has(h.hero_id);
              const isDisabled = !isSelected && selected.size >= 6;
              return (
                <div
                  key={h.hero_id}
                  className={`hero-chip ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                  onClick={() => !isDisabled && onToggle(h.hero_id)}
                >
                  {capitalize(h.name)}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

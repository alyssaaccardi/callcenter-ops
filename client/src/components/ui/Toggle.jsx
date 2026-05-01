import React from 'react';

// iOS-style toggle (big = status board big toggle, small = pill toggle)
export function BigToggle({ checked, onChange, id }) {
  return (
    <label className="big-toggle" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="big-toggle-track" />
      <span className="big-toggle-thumb" />
    </label>
  );
}

export function PillToggle({ checked, onChange, id }) {
  return (
    <label className="toggle-pill" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="toggle-pill-track" />
      <span className="toggle-pill-thumb" />
    </label>
  );
}

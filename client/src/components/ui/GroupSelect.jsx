import React, { useState, useRef, useEffect } from 'react';

export default function GroupSelect({ groups, selected, onChange, loading }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = groups.filter(g => {
    const name = g.Name || g.name || g.GroupName || String(g);
    return name.toLowerCase().includes(query.toLowerCase());
  });

  function toggleGroup(g) {
    const id = g.ID || g.id || g.GroupID || g;
    const name = g.Name || g.name || g.GroupName || String(g);
    const alreadySelected = selected.find(s => s.id === id);
    if (alreadySelected) {
      onChange(selected.filter(s => s.id !== id));
    } else {
      onChange([...selected, { id, name }]);
    }
  }

  function removeTag(id) {
    onChange(selected.filter(s => s.id !== id));
  }

  return (
    <div className="group-search-wrap" ref={wrapRef}>
      <div
        className="group-multiselect"
        onClick={() => { setOpen(true); }}
      >
        {selected.map(s => (
          <span key={s.id} className="group-sel-tag">
            {s.name}
            <span
              className="group-sel-tag-x"
              onClick={e => { e.stopPropagation(); removeTag(s.id); }}
            >×</span>
          </span>
        ))}
        <input
          className="group-search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? 'Search groups…' : ''}
          autoComplete="off"
        />
      </div>

      {open && (
        <div className="group-dropdown">
          {loading && <div className="group-dropdown-empty">Dialing in...</div>}
          {!loading && filtered.length === 0 && (
            <div className="group-dropdown-empty">No groups found</div>
          )}
          {!loading && filtered.map(g => {
            const id = g.ID || g.id || g.GroupID || g;
            const name = g.Name || g.name || g.GroupName || String(g);
            const isSel = !!selected.find(s => s.id === id);
            return (
              <div
                key={id}
                className={`group-dropdown-item${isSel ? ' selected' : ''}`}
                onClick={() => toggleGroup(g)}
              >
                {isSel ? '✓' : <span style={{ display: 'inline-block', width: 11 }} />}
                {name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

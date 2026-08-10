import { useState } from 'react';
import './ui.css';

/* columns: [{ key, header, align, num, width, sortable, render(row) }]
   rows:    array of objects
   rowState(row) -> 'warn' | 'crit' | 'selected' | undefined

   Sticky header, sort, density and pager in one place, so no module has to
   solve them again. Sorting and density are uncontrolled unless you pass
   onSortChange / onDensityChange. */
export default function Table({
  columns = [], rows = [], rowKey = (r, i) => (r.id !== undefined ? r.id : i), rowState,
  density = 'compact', onDensityChange, maxHeight,
  sort, onSortChange, foot, showDensity = true,
  page, pageCount = 1, onPageChange, className = ''
}) {
  const [localDensity, setLocalDensity] = useState(density);
  const d = onDensityChange ? density : localDensity;
  const setD = onDensityChange || setLocalDensity;

  const [localSort, setLocalSort] = useState(sort || null);
  const s = onSortChange ? sort : localSort;
  const setS = onSortChange || setLocalSort;

  const clickSort = (col) => {
    if (!col.sortable) return;
    const dir = s && s.key === col.key && s.dir === 'desc' ? 'asc' : 'desc';
    setS({ key: col.key, dir });
  };

  const sorted = (!onSortChange && s)
    ? [...rows].sort((a, b) => {
        const av = a[s.key], bv = b[s.key];
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av === undefined || av === null ? '' : av).localeCompare(String(bv === undefined || bv === null ? '' : bv));
        return s.dir === 'asc' ? cmp : -cmp;
      })
    : rows;

  const hasFoot = foot || showDensity || pageCount > 1;

  return (
    <div className={['ui-table-wrap', className].filter(Boolean).join(' ')}>
      <div className="ui-table-scroll" style={maxHeight ? { maxHeight } : undefined}>
        <table className={'ui-table' + (d === 'comfortable' ? ' ui-table--comfortable' : '')}>
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  data-align={col.align}
                  data-sortable={col.sortable ? true : undefined}
                  data-active={s && s.key === col.key ? true : undefined}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={() => clickSort(col)}
                >
                  {col.header}
                  {s && s.key === col.key && (
                    <span className="ui-table__arrow">{s.dir === 'asc' ? '\u25B2' : '\u25BC'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={rowKey(row, i)} data-state={rowState ? rowState(row) : undefined}>
                {columns.map(col => (
                  <td key={col.key} data-align={col.align} data-num={col.num ? true : undefined}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasFoot && (
        <div className="ui-table__foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {foot && <span>{foot}</span>}
            {showDensity && <DensitySwitch value={d} onChange={setD} />}
          </div>
          {pageCount > 1 && (
            <div className="ui-table__pager">
              <button className="ui-table__page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Prev</button>
              {Array.from({ length: Math.min(pageCount, 5) }, (_, n) => n + 1).map(n => (
                <button key={n} className="ui-table__page" data-current={n === page} onClick={() => onPageChange(n)}>{n}</button>
              ))}
              <button className="ui-table__page" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DensitySwitch({ value, onChange }) {
  return (
    <div className="ui-density">
      <button data-active={value === 'compact'} onClick={() => onChange('compact')}>Compact</button>
      <button data-active={value === 'comfortable'} onClick={() => onChange('comfortable')}>Comfortable</button>
    </div>
  );
}

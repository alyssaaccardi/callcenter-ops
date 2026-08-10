import './ui.css';

/* tabs: [{ id, label, count }] */
export default function Tabs({ tabs = [], value, onChange, className = '' }) {
  return (
    <div className={['ui-tabs', className].filter(Boolean).join(' ')} role="tablist">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          data-active={t.id === value}
          className="ui-tabs__tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="ui-tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

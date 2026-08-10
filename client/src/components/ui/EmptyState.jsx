import './ui.css';

/* Every list, table and queue needs one. Say what is true, then offer the
   single action that changes it. */
export default function EmptyState({ glyph, title, description, actions, className = '' }) {
  return (
    <div className={['ui-empty', className].filter(Boolean).join(' ')}>
      <div className="ui-empty__glyph" aria-hidden="true">{glyph}</div>
      {title && <div className="ui-empty__title">{title}</div>}
      {description && <div className="ui-empty__desc">{description}</div>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}

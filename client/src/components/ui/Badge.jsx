import './ui.css';

/* tone: ok | warn | crit | info | accent | neutral — one meaning per tone,
   app-wide. Use StatusPill for system/ticket status so dots stay consistent. */
export default function Badge({ tone = 'neutral', dot = false, pulse = false, size, children, className = '', ...rest }) {
  const cls = ['ui-badge', 'ui-badge--' + tone];
  if (size === 'sm') cls.push('ui-badge--sm');
  if (className) cls.push(className);

  return (
    <span className={cls.join(' ')} {...rest}>
      {dot && <span className={'ui-badge__dot' + (pulse ? ' ui-badge__dot--pulse' : '')} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* Monospace squared tag for roles — visually distinct from status badges.
   Keep the tone map in sync with ROLE_STYLE in components/UserManagement.jsx. */
export function Tag({ tone = 'neutral', children, className = '', ...rest }) {
  return <span className={['ui-tag', 'ui-tag--' + tone, className].filter(Boolean).join(' ')} {...rest}>{children}</span>;
}

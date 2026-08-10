import './ui.css';

/* Replaces every per-module panel class. Pass pad for a plain padded box,
   or use eyebrow/title/actions/foot for the structured variant. */
export default function Card({
  eyebrow, title, actions, foot, pad = false, hero = false, flat = false,
  interactive = false, children, className = '', ...rest
}) {
  const cls = ['ui-card'];
  if (hero) cls.push('ui-card--hero');
  if (flat) cls.push('ui-card--flat');
  if (interactive) cls.push('ui-card--interactive');
  if (pad) cls.push('ui-card--pad');
  if (className) cls.push(className);

  const hasHead = eyebrow || title || actions;

  return (
    <section className={cls.join(' ')} {...rest}>
      {hasHead && (
        <header className="ui-card__head">
          <div>
            {eyebrow && <div className="ui-card__eyebrow">{eyebrow}</div>}
            {title && <div className="ui-card__title">{title}</div>}
          </div>
          {actions}
        </header>
      )}
      {pad ? children : <div className="ui-card__body">{children}</div>}
      {foot && <footer className="ui-card__foot">{foot}</footer>}
    </section>
  );
}

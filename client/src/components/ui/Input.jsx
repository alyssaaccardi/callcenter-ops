import './ui.css';

export default function Input({
  label, hint, error, icon, mono = false, textarea = false,
  id, className = '', ...rest
}) {
  const fieldId = id || rest.name || undefined;
  const cls = [textarea ? 'ui-textarea' : 'ui-input'];
  if (mono) cls.push('ui-input--mono');
  if (error) cls.push('ui-input--error');
  if (className) cls.push(className);

  const control = textarea
    ? <textarea id={fieldId} className={cls.join(' ')} {...rest} />
    : <input id={fieldId} className={cls.join(' ')} {...rest} />;

  return (
    <div className="ui-field">
      {label && (
        <label htmlFor={fieldId} className={'ui-field__label' + (error ? ' ui-field__label--error' : '')}>
          {label}
        </label>
      )}
      {icon
        ? <div className="ui-input-wrap ui-input-wrap--icon">
            <span className="ui-input-wrap__icon" aria-hidden="true">{icon}</span>
            {control}
          </div>
        : control}
      {error ? <div className="ui-field__error">{error}</div>
             : hint ? <div className="ui-field__hint">{hint}</div> : null}
    </div>
  );
}

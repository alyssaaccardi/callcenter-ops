import './ui.css';

/* options: [{ value, label }] or plain strings.
   For the multi-select typeahead, keep using the existing GroupSelect. */
export default function Select({
  label, hint, error, options = [], placeholder, id, className = '', children, ...rest
}) {
  const fieldId = id || rest.name || undefined;
  const cls = ['ui-select'];
  if (error) cls.push('ui-select--error');
  if (className) cls.push(className);

  return (
    <div className="ui-field">
      {label && <label htmlFor={fieldId} className={'ui-field__label' + (error ? ' ui-field__label--error' : '')}>{label}</label>}
      <select id={fieldId} className={cls.join(' ')} {...rest}>
        {placeholder && <option value="">{placeholder}</option>}
        {children || options.map(o => {
          const value = typeof o === 'string' ? o : o.value;
          const text = typeof o === 'string' ? o : o.label;
          return <option key={value} value={value}>{text}</option>;
        })}
      </select>
      {error ? <div className="ui-field__error">{error}</div>
             : hint ? <div className="ui-field__hint">{hint}</div> : null}
    </div>
  );
}

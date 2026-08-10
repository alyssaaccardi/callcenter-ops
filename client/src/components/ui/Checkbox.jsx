import './ui.css';

/* Set radio for a radio control. Pairs with the existing Toggle for on/off
   settings — checkbox is for filters and multi-select. */
export default function Checkbox({ label, radio = false, className = '', ...rest }) {
  const cls = ['ui-check'];
  if (radio) cls.push('ui-check--radio');
  if (className) cls.push(className);

  return (
    <label className={cls.join(' ')}>
      <input type={radio ? 'radio' : 'checkbox'} {...rest} />
      <span className="ui-check__box" aria-hidden="true">{radio ? '' : '\u2713'}</span>
      <span className="ui-check__label">{label}</span>
    </label>
  );
}

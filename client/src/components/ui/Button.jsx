import './ui.css';

/* variant: primary | secondary | ghost | danger | link
   size: sm | md | lg */
export default function Button({
  variant = 'primary', size = 'md', block = false, loading = false,
  icon = null, children, className = '', ...rest
}) {
  const cls = ['ui-btn', 'ui-btn--' + variant, 'ui-btn--' + size];
  if (block) cls.push('ui-btn--block');
  if (className) cls.push(className);

  return (
    <button className={cls.join(' ')} data-loading={loading} {...rest}>
      {loading ? <span className="ui-btn__spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

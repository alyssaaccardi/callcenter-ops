import { useEffect, useRef } from 'react';
import './ui.css';

/* Escape to close, scrim click to close, focus moves into the dialog, body
   scroll locked. Every hand-rolled module overlay should become this. */
export default function Modal({ open, onClose, title, description, footer, wide = false, children }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (ref.current) ref.current.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-modal__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={'ui-modal' + (wide ? ' ui-modal--wide' : '')}
      >
        {(title || description) && (
          <div className="ui-modal__head">
            {title && <div className="ui-modal__title">{title}</div>}
            {description && <div className="ui-modal__desc">{description}</div>}
          </div>
        )}
        {children && <div className="ui-modal__body">{children}</div>}
        {footer && <div className="ui-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

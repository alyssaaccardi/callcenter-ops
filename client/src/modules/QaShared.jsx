export function Section({ label, children }) {
  return (
    <div className="qa-section">
      <div className="qa-section-label">{label}</div>
      {children}
    </div>
  );
}

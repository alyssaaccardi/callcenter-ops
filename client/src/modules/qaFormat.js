// Formatting helpers for the testing platform. A plain module, not a
// component file, so fast refresh keeps working for the views that use it.

export const fmtWhen = (s) => {
  if (!s) return '';
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; without
  // the Z it would be read as local time and every timestamp would drift.
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? s : d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
};

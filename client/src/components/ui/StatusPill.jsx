import './ui.css';
import Badge from './Badge';

/* The app's status vocabulary in one place. Import this instead of writing
   another up/down class — StatusBoard, the Sidebar pill, SupportCenter and
   TechCenter should all read from this map. */
export const STATUS = {
  operational:   { tone: 'ok',      label: 'Operational' },
  up:            { tone: 'ok',      label: 'Operational' },
  matched:       { tone: 'ok',      label: 'Matched' },
  done:          { tone: 'ok',      label: 'Done' },
  degraded:      { tone: 'warn',    label: 'Degraded' },
  'due-soon':    { tone: 'warn',    label: 'Due soon' },
  tolerance:     { tone: 'warn',    label: 'Within tolerance' },
  outage:        { tone: 'crit',    label: 'Outage',  pulse: true },
  down:          { tone: 'crit',    label: 'Outage',  pulse: true },
  overdue:       { tone: 'crit',    label: 'Overdue', pulse: true },
  overage:       { tone: 'crit',    label: 'Overage' },
  working:       { tone: 'info',    label: 'Working' },
  'in-progress': { tone: 'info',    label: 'In progress' },
  standby:       { tone: 'neutral', label: 'Standby' },
  archived:      { tone: 'neutral', label: 'Archived' },
  unknown:       { tone: 'neutral', label: 'Unknown' }
};

export default function StatusPill({ status, label, size, className = '', ...rest }) {
  const s = STATUS[status] || STATUS.unknown;
  return (
    <Badge tone={s.tone} dot pulse={s.pulse} size={size} className={className} {...rest}>
      {label || s.label}
    </Badge>
  );
}

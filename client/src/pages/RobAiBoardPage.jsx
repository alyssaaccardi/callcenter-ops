import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import api from '../api';
import { useApp } from '../context/AppContext';
import './RobAiBoardPage.css';

const STATUSES = [
  { label: 'Lead Pool',        hex: '#c4c4c4' },
  { label: 'Intro Email',      hex: '#fdab3d' },
  { label: 'Warm Lead',        hex: '#ff6d3b' },
  { label: 'Pitched',          hex: '#cab641' },
  { label: 'Call Back',        hex: '#007eb5' },
  { label: 'Closed Deal',      hex: '#9cd326' },
  { label: 'NGOP',             hex: '#df2f4a' },
  { label: 'Bad Lead',         hex: '#579bfc' },
  { label: 'Not Interested',   hex: '#037f4c' },
  { label: 'Current Customer', hex: '#ffcb00' },
];

const ENTITY_LABELS = ['Ring Savvvy', 'Answering Legal', 'ANSWERING LEGAL', 'RING SAVVY'];
const LEAD_HISTORY = ['Dead Beat', 'Cancellation Price', 'Never Started', 'Price', 'AI', "Wanted Service We Don't Offer"];

function entityGroup(label) {
  if (!label) return null;
  const l = label.toUpperCase();
  if (l.includes('ANSWERING')) return 'AL';
  if (l.includes('SAVV') || l.includes('RING')) return 'RS';
  return null;
}

function colText(item, id) {
  return item.column_values?.find(c => c.id === id)?.text || '';
}
function colValue(item, id) {
  const v = item.column_values?.find(c => c.id === id)?.value;
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

function Card({ item, onDragStart, onOpen }) {
  const company = colText(item, 'text_mm5qhveb') || item.name;
  const contact = colText(item, 'text_mm5q18yn');
  const phone   = colText(item, 'phone_mm5q78nv');
  const entity  = colText(item, 'dropdown_mm5qvrnf');
  const cbDate  = colText(item, 'date_mm5rmtn5');
  const eg      = entityGroup(entity);

  return (
    <div
      className="rai-card"
      draggable
      onDragStart={e => onDragStart(e, item.id)}
      onClick={() => onOpen(item)}
    >
      <div className="rai-card-title">{company}</div>
      {contact && <div className="rai-card-line">{contact}</div>}
      {phone && <div className="rai-card-line rai-card-phone">{phone}</div>}
      <div className="rai-card-footer">
        {eg && <span className={`rai-entity-badge rai-entity-${eg.toLowerCase()}`}>{eg}</span>}
        {cbDate && <span className="rai-cb-date">📞 {cbDate}</span>}
      </div>
    </div>
  );
}

function Column({ status, items, visible, onShowMore, onDragOver, onDrop, onDragStart, onOpen }) {
  const shown  = items.slice(0, visible);
  const hidden = items.length - shown.length;
  return (
    <div
      className="rai-column"
      onDragOver={onDragOver}
      onDrop={e => onDrop(e, status.label)}
    >
      <div className="rai-column-header" style={{ background: status.hex }}>
        <span className="rai-column-title">{status.label}</span>
        <span className="rai-column-count">{items.length}</span>
      </div>
      <div className="rai-column-body">
        {shown.map(item => (
          <Card key={item.id} item={item} onDragStart={onDragStart} onOpen={onOpen} />
        ))}
        {hidden > 0 && (
          <button className="rai-show-more" onClick={onShowMore}>
            Show {Math.min(hidden, 50)} more <span>({hidden} hidden)</span>
          </button>
        )}
      </div>
    </div>
  );
}

function EditField({ label, children }) {
  return (
    <label className="rai-field">
      <span className="rai-field-label">{label}</span>
      {children}
    </label>
  );
}

function CardModal({ item, mondayUsers, groups, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    name:      item.name || '',
    company:   colText(item, 'text_mm5qhveb'),
    contact:   colText(item, 'text_mm5q18yn'),
    phone:     colText(item, 'phone_mm5q78nv'),
    phone2:    colText(item, 'text_mm5q1f9s'),
    email:     colText(item, 'email_mm5rh2bj'),
    website:   colText(item, 'link_mm5qd6fd'),
    address:   colText(item, 'location_mm5qqqav'),
    state:     colText(item, 'text_mm5r1w34'),
    entity:    colText(item, 'dropdown_mm5qvrnf'),
    business:  colText(item, 'text_mm5rse7y'),
    history:   colText(item, 'dropdown_mm5qsgmy'),
    status:    colText(item, 'status'),
    date:      colText(item, 'date4'),
    cbDate:    colText(item, 'date_mm5rmtn5'),
    notes:     colText(item, 'long_text_mm5r5gd'),
    personId:  colValue(item, 'person')?.personsAndTeams?.[0]?.id || '',
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  // Split "YYYY-MM-DD HH:MM" into parts for date+time inputs. Monday returns text like "2026-08-20 14:30".
  function splitDT(v) {
    if (!v) return { d: '', t: '' };
    const [d, t] = v.split(' ');
    return { d: d || '', t: t ? t.slice(0, 5) : '' };
  }
  const cb = splitDT(form.cbDate);

  async function submit() {
    setSaving(true); setErr('');
    // Build list of dirty columns and their payloads
    const updates = [];
    const push = (colId, value) => updates.push({ columnId: colId, value });

    if (form.name !== item.name) push('name', form.name); // 'name' column
    if (form.company !== colText(item, 'text_mm5qhveb'))  push('text_mm5qhveb', form.company);
    if (form.contact !== colText(item, 'text_mm5q18yn'))  push('text_mm5q18yn', form.contact);
    if (form.phone   !== colText(item, 'phone_mm5q78nv')) push('phone_mm5q78nv', form.phone);
    if (form.phone2  !== colText(item, 'text_mm5q1f9s'))  push('text_mm5q1f9s', form.phone2);
    if (form.email   !== colText(item, 'email_mm5rh2bj')) push('email_mm5rh2bj', form.email ? { email: form.email, text: form.email } : {});
    if (form.website !== colText(item, 'link_mm5qd6fd'))  push('link_mm5qd6fd', form.website ? { url: form.website, text: form.website } : {});
    if (form.address !== colText(item, 'location_mm5qqqav')) push('location_mm5qqqav', form.address ? { address: form.address } : {});
    if (form.state   !== colText(item, 'text_mm5r1w34'))  push('text_mm5r1w34', form.state);
    if (form.entity  !== colText(item, 'dropdown_mm5qvrnf')) push('dropdown_mm5qvrnf', form.entity);
    if (form.business !== colText(item, 'text_mm5rse7y')) push('text_mm5rse7y', form.business);
    if (form.history  !== colText(item, 'dropdown_mm5qsgmy')) push('dropdown_mm5qsgmy', form.history);
    if (form.status   !== colText(item, 'status'))        push('status', form.status);
    if (form.date     !== colText(item, 'date4'))         push('date4', form.date ? { date: form.date } : {});
    const nextCb = cb.d ? { date: cb.d, ...(cb.t ? { time: `${cb.t}:00` } : {}) } : {};
    if (form.cbDate !== colText(item, 'date_mm5rmtn5'))   push('date_mm5rmtn5', nextCb);
    if (form.notes !== colText(item, 'long_text_mm5r5gd')) push('long_text_mm5r5gd', form.notes);
    const curPerson = colValue(item, 'person')?.personsAndTeams?.[0]?.id || '';
    if (String(form.personId) !== String(curPerson)) {
      push('person', form.personId ? { personsAndTeams: [{ id: Number(form.personId), kind: 'person' }] } : {});
    }

    try {
      for (const u of updates) {
        await api.post('/api/rob-ai-board/update', { itemId: item.id, ...u });
      }
      onSave();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rai-modal-backdrop" onClick={onClose}>
      <div className="rai-modal" onClick={e => e.stopPropagation()}>
        <div className="rai-modal-header">
          <input className="rai-modal-title-input" value={form.name} onChange={e => set('name', e.target.value)} />
          <button className="rai-modal-close" onClick={onClose}>×</button>
        </div>
        {err && <div className="rai-modal-err">{err}</div>}
        <div className="rai-modal-body">
          <EditField label="Company Name">
            <input value={form.company} onChange={e => set('company', e.target.value)} />
          </EditField>
          <EditField label="Main Contact">
            <input value={form.contact} onChange={e => set('contact', e.target.value)} />
          </EditField>
          <div className="rai-row-2">
            <EditField label="Phone">
              <input value={form.phone} onChange={e => set('phone', e.target.value)} />
            </EditField>
            <EditField label="Phone 2">
              <input value={form.phone2} onChange={e => set('phone2', e.target.value)} />
            </EditField>
          </div>
          <EditField label="Email">
            <input type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </EditField>
          <EditField label="Website">
            <input value={form.website} onChange={e => set('website', e.target.value)} />
          </EditField>
          <EditField label="Address">
            <input value={form.address} onChange={e => set('address', e.target.value)} />
          </EditField>
          <div className="rai-row-2">
            <EditField label="State">
              <input value={form.state} onChange={e => set('state', e.target.value)} />
            </EditField>
            <EditField label="Business Type">
              <input value={form.business} onChange={e => set('business', e.target.value)} />
            </EditField>
          </div>
          <div className="rai-row-2">
            <EditField label="Entity">
              <select value={form.entity} onChange={e => set('entity', e.target.value)}>
                <option value="">—</option>
                {ENTITY_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </EditField>
            <EditField label="Lead History">
              <select value={form.history} onChange={e => set('history', e.target.value)}>
                <option value="">—</option>
                {LEAD_HISTORY.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </EditField>
          </div>
          <div className="rai-row-2">
            <EditField label="Status">
              <select value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="">—</option>
                {STATUSES.map(s => <option key={s.label} value={s.label}>{s.label}</option>)}
              </select>
            </EditField>
            <EditField label="Owner">
              <select value={form.personId} onChange={e => set('personId', e.target.value)}>
                <option value="">Unassigned</option>
                {mondayUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </EditField>
          </div>
          <div className="rai-row-2">
            <EditField label="Date">
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)} />
            </EditField>
            <EditField label="Call Back">
              <div className="rai-cb-inputs">
                <input type="date" value={cb.d} onChange={e => set('cbDate', `${e.target.value}${cb.t ? ' ' + cb.t : ''}`)} />
                <input type="time" value={cb.t} onChange={e => set('cbDate', `${cb.d}${e.target.value ? ' ' + e.target.value : ''}`)} />
              </div>
            </EditField>
          </div>
          <EditField label="Rob AI Notes">
            <textarea rows={6} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </EditField>
          <div className="rai-modal-meta">
            <span>Hubspot ID: {colText(item, 'text_mm5rkkb5') || '—'}</span>
            <a href={`https://answeringlegal-unit.monday.com/boards/18424304525/pulses/${item.id}`} target="_blank" rel="noreferrer">Open in Monday ↗</a>
          </div>
        </div>
        <div className="rai-modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function RobAiBoardPage() {
  const { toast } = useApp();
  const [cache, setCache] = useState(null);
  const [entityFilter, setEntityFilter] = useState('all'); // all | AL | RS
  const [search, setSearch] = useState('');
  const [openItem, setOpenItem] = useState(null);
  const [pendingMoves, setPendingMoves] = useState({}); // itemId -> optimistic status
  const [visibleCounts, setVisibleCounts] = useState({}); // statusLabel -> override count
  const dragId = useRef(null);

  const DEFAULT_VISIBLE = 50;
  const visibleFor = s => visibleCounts[s] ?? DEFAULT_VISIBLE;
  const showMore = s => setVisibleCounts(v => ({ ...v, [s]: visibleFor(s) + 50 }));

  const refetch = useCallback(async () => {
    try {
      const r = await api.get('/api/rob-ai-board/items');
      setCache(r.data);
    } catch (e) { /* stream will retry */ }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const es = new EventSource('/api/rob-ai-board/stream', { withCredentials: true });
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        setCache(data);
        setPendingMoves({}); // server truth wins on next tick
      } catch {}
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
  }, []);

  const items      = cache?.items || [];
  const mondayUsers = cache?.mondayUsers || [];
  const groups     = cache?.groups || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(it => {
      if (entityFilter !== 'all') {
        const eg = entityGroup(colText(it, 'dropdown_mm5qvrnf'));
        if (eg !== entityFilter) return false;
      }
      if (q) {
        const hay = [
          it.name,
          colText(it, 'text_mm5qhveb'),
          colText(it, 'text_mm5q18yn'),
          colText(it, 'phone_mm5q78nv'),
          colText(it, 'email_mm5rh2bj'),
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, entityFilter, search]);

  const byStatus = useMemo(() => {
    const m = new Map(STATUSES.map(s => [s.label, []]));
    for (const it of filtered) {
      const s = pendingMoves[it.id] ?? colText(it, 'status');
      if (m.has(s)) m.get(s).push(it);
    }
    // Sort each column by most recently updated so the useful ones are always on top
    for (const list of m.values()) {
      list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    }
    return m;
  }, [filtered, pendingMoves]);

  function handleDragStart(e, id) {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
  function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  async function handleDrop(e, statusLabel) {
    e.preventDefault();
    const id = dragId.current || e.dataTransfer.getData('text/plain');
    dragId.current = null;
    if (!id) return;
    const item = items.find(i => i.id === id);
    if (!item) return;
    if (colText(item, 'status') === statusLabel) return;
    setPendingMoves(p => ({ ...p, [id]: statusLabel }));
    try {
      await api.post('/api/rob-ai-board/update', { itemId: id, columnId: 'status', value: statusLabel });
    } catch (err) {
      setPendingMoves(p => { const n = { ...p }; delete n[id]; return n; });
      toast?.('Failed to update status', 'error');
    }
  }

  if (!cache) {
    return (
      <div className="rai-page rai-loading">
        <span className="spinner" />
        <div>Loading Rob's AI Board…</div>
      </div>
    );
  }

  return (
    <div className="rai-page">
      <div className="rai-toolbar">
        <div className="rai-toolbar-left">
          <h2 className="rai-title">Rob's AI Board</h2>
          <span className="rai-count">{filtered.length} of {items.length} leads</span>
        </div>
        <div className="rai-toolbar-right">
          <input
            className="rai-search"
            placeholder="Search company, contact, phone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="rai-entity-filter">
            {[
              { v: 'all', l: 'All' },
              { v: 'AL',  l: 'Answering Legal' },
              { v: 'RS',  l: 'Ring Savvy' },
            ].map(o => (
              <button
                key={o.v}
                className={`rai-entity-btn${entityFilter === o.v ? ' active' : ''}`}
                onClick={() => setEntityFilter(o.v)}
              >{o.l}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="rai-board">
        {STATUSES.map(s => (
          <Column
            key={s.label}
            status={s}
            items={byStatus.get(s.label) || []}
            visible={visibleFor(s.label)}
            onShowMore={() => showMore(s.label)}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragStart={handleDragStart}
            onOpen={setOpenItem}
          />
        ))}
      </div>

      {openItem && (
        <CardModal
          item={openItem}
          mondayUsers={mondayUsers}
          groups={groups}
          onClose={() => setOpenItem(null)}
          onSave={refetch}
        />
      )}
    </div>
  );
}

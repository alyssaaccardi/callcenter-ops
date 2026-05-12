import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import api from '../api';

function maskUrl(url) {
  if (!url) return '(no URL — click Edit to add one)';
  return url.replace(/(hooks\.slack\.com\/triggers\/[^/]+\/)\S+/, '$1••••••••/••••••••');
}

function WorkflowModal({ workflow, onSave, onClose }) {
  const isEdit = !!workflow?.id;
  const [name,        setName]        = useState(workflow?.name        || '');
  const [scope,       setScope]       = useState(workflow?.scope       || '');
  const [icon,        setIcon]        = useState(workflow?.icon        || '⚡');
  const [url,         setUrl]         = useState(workflow?.url         || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [saving,      setSaving]      = useState(false);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    await onSave({ name: name.trim(), scope: scope.trim(), icon: icon || '⚡', url: url.trim(), description: description.trim() });
    setSaving(false);
  }

  return (
    <div className="wf-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="wf-modal">
        <div className="wf-modal-header">
          <span className="wf-modal-title">{isEdit ? 'Edit Workflow' : 'Add Workflow'}</span>
          <button className="wf-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body">
          <div className="wf-field-row">
            <div className="wf-field" style={{ flex: '0 0 72px' }}>
              <label className="field-label">Icon</label>
              <input className="wf-icon-input" value={icon} onChange={e => setIcon(e.target.value)} maxLength={2} placeholder="⚡" />
            </div>
            <div className="wf-field" style={{ flex: 1 }}>
              <label className="field-label">Name *</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DIDs Unavailable" autoFocus />
            </div>
          </div>
          <div className="wf-field">
            <label className="field-label">Category / Scope</label>
            <input value={scope} onChange={e => setScope(e.target.value)} placeholder="e.g. DID Status, Savvy Phone, General" />
          </div>
          <div className="wf-field">
            <label className="field-label">Slack Webhook / Workflow URL</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.slack.com/triggers/..." />
          </div>
          <div className="wf-field">
            <label className="field-label">Description (optional)</label>
            <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="When to fire this workflow and what it does..." style={{ minHeight: 54, resize: 'vertical' }} />
          </div>
        </div>
        <div className="wf-modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <span className="spinner" /> : (isEdit ? 'Save Changes' : 'Add Workflow')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirm({ workflow, onConfirm, onClose }) {
  return (
    <div className="wf-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="wf-modal wf-modal-sm">
        <div className="wf-modal-header">
          <span className="wf-modal-title">Delete Workflow</span>
          <button className="wf-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body">
          <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text, #1a1a3e)' }}>
            Delete <strong>"{workflow.name}"</strong>? This action will be recorded in the audit log and cannot be undone.
          </p>
        </div>
        <div className="wf-modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm wf-delete-btn" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export default function SlackWorkflows() {
  const { toast, addLog } = useApp();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [workflows,     setWorkflows]     = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [firing,        setFiring]        = useState(null);
  const [lastTriggered, setLastTriggered] = useState({});
  const [auditLog,      setAuditLog]      = useState([]);
  const [modalWf,       setModalWf]       = useState(null);
  const [deleteWf,      setDeleteWf]      = useState(null);

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await api.get('/api/slack/workflows');
      setWorkflows(res.data || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWorkflows(); }, [fetchWorkflows]);

  function logLocal(msg, type = 'ok') {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }),
      msg, type,
    };
    setAuditLog(prev => [entry, ...prev].slice(0, 100));
    addLog(msg, type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'ok');
  }

  async function fireWorkflow(wf) {
    setFiring(wf.id);
    try {
      const res = await api.post(`/api/slack/workflows/${wf.id}/fire`);
      if (res.data?.openUrl) window.open(res.data.openUrl, '_blank');
      setLastTriggered(prev => ({ ...prev, [wf.id]: new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' EST' }));
      toast(`Fired: ${wf.name}`, 'success');
      logLocal(`Fired workflow: ${wf.name}`, 'ok');
    } catch (e) {
      toast(`Failed to fire: ${wf.name}`, 'error');
      logLocal(`Failed to fire: ${wf.name} — ${e.response?.data?.error || e.message}`, 'err');
    } finally {
      setFiring(null);
    }
  }

  async function handleSave(data) {
    try {
      if (modalWf?.id) {
        const res = await api.put(`/api/slack/workflows/${modalWf.id}`, data);
        setWorkflows(prev => prev.map(w => w.id === modalWf.id ? res.data : w));
        toast('Workflow updated', 'success');
        logLocal(`Updated workflow: "${data.name}"`, 'ok');
      } else {
        const res = await api.post('/api/slack/workflows', data);
        setWorkflows(prev => [...prev, res.data]);
        toast('Workflow added', 'success');
        logLocal(`Added workflow: "${data.name}"`, 'ok');
      }
      setModalWf(null);
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to save workflow', 'error');
    }
  }

  async function handleDelete() {
    const wf = deleteWf;
    try {
      await api.delete(`/api/slack/workflows/${wf.id}`);
      setWorkflows(prev => prev.filter(w => w.id !== wf.id));
      toast(`Deleted: ${wf.name}`, 'success');
      logLocal(`Deleted workflow: "${wf.name}"`, 'warn');
      setDeleteWf(null);
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to delete', 'error');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Slack Workflows</div>
          <div className="page-sub">
            {isSuperAdmin ? 'Manage and fire status notification workflows' : 'Fire status notification workflows'}
          </div>
        </div>
        {isSuperAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setModalWf({})}>
            + Add Workflow
          </button>
        )}
      </div>

      <div className="mb-20">
        {loading && (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <span className="spinner" />
          </div>
        )}
        {!loading && workflows.map(wf => (
          <div key={wf.id} className="workflow-card">
            <div className="workflow-card-header">
              <span style={{ fontSize: 20 }}>{wf.icon}</span>
              <span className="workflow-name">{wf.name}</span>
              {wf.scope && <span className="workflow-scope">{wf.scope}</span>}
              {wf.builtin && <span className="wf-builtin-badge">built-in</span>}
            </div>
            {wf.description && <div className="wf-description">{wf.description}</div>}
            {isSuperAdmin && (
              <div className="workflow-url-display">{maskUrl(wf.url)}</div>
            )}
            <div className="workflow-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => fireWorkflow(wf)}
                disabled={firing === wf.id}
              >
                {firing === wf.id ? <span className="spinner" /> : '⚡'} Fire
              </button>
              {isSuperAdmin && (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={() => setModalWf(wf)}>
                    ✏️ Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: wf.builtin ? 'var(--muted)' : 'var(--danger)', opacity: wf.builtin ? 0.4 : 1 }}
                    onClick={() => !wf.builtin && setDeleteWf(wf)}
                    title={wf.builtin ? 'Built-in workflows cannot be deleted' : 'Delete workflow'}
                    disabled={!!wf.builtin}
                  >
                    🗑️ Delete
                  </button>
                </>
              )}
              {lastTriggered[wf.id] && (
                <span className="last-triggered">Last fired: {lastTriggered[wf.id]}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">Audit Log</div>
        <div className="log-feed">
          {auditLog.length === 0 && <div className="log-empty">No activity yet this session.</div>}
          {auditLog.map((e, i) => (
            <div key={i} className="log-entry">
              <span className="log-time">{e.time}</span>
              <span className={`log-msg ${e.type}`}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>

      {modalWf !== null && (
        <WorkflowModal
          workflow={modalWf?.id ? modalWf : null}
          onSave={handleSave}
          onClose={() => setModalWf(null)}
        />
      )}
      {deleteWf && (
        <DeleteConfirm
          workflow={deleteWf}
          onConfirm={handleDelete}
          onClose={() => setDeleteWf(null)}
        />
      )}
    </div>
  );
}

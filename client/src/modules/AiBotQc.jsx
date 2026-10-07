import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, AudioLines, BarChart3, Check, ChevronDown, Clock3, Download, ExternalLink, Trash2,
  CheckCheck, Headphones, History, ListChecks, Megaphone, PhoneForwarded, RefreshCw, Search, Settings2, ShieldAlert, UserRound, X,
} from 'lucide-react';
import { OggOpusDecoderWebWorker } from 'ogg-opus-decoder';
import airiLogo from '../assets/airi.avif';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import './AiBotQc.css';

const HAPPINESS_RATINGS = [
  { value: 1, face: '😞', label: 'Very unhappy' },
  { value: 2, face: '🙁', label: 'Unhappy' },
  { value: 3, face: '😐', label: 'Neutral' },
  { value: 4, face: '🙂', label: 'Happy' },
  { value: 5, face: '😄', label: 'Very happy' },
];

const CALL_SIGNAL_FLAGS = [
  { value: 'bot_hangup', label: 'Caller hung up, possibly due to the bot', shortLabel: 'Bot-related hang-up' },
  { value: 'sales_spam', label: 'Sales, spam, or marketing call', shortLabel: 'Sales / spam / marketing' },
  { value: 'very_satisfied', label: 'Caller sounded very satisfied', shortLabel: 'Very satisfied' },
  { value: 'no_interaction', label: 'No meaningful interaction on the call', shortLabel: 'No interaction' },
  { value: 'greeting_only', label: 'Caller only said a greeting', shortLabel: 'Greeting only' },
  { value: 'intent_misunderstood', label: 'Bot misunderstood the caller’s intent', shortLabel: 'Intent misunderstood' },
  { value: 'handoff_needed', label: 'Transfer or escalation was needed', shortLabel: 'Handoff needed' },
  { value: 'incorrect_information', label: 'Bot gave incorrect information', shortLabel: 'Incorrect information' },
];

function accountLabel(value = '') {
  return value.replaceAll('_', ' ');
}

function formatCallerId(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return value || '';
}

function HubSpotAccount({ check }) {
  const label = accountLabel(check.customer);
  if (!check.hubspot_deal_id) return label;
  return <a className="botqc-hubspot-link" href={`https://app.hubspot.com/contacts/*/deal/${encodeURIComponent(check.hubspot_deal_id)}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${label} HubSpot deal`}>
    {label}<ExternalLink size={11} aria-hidden="true" />
  </a>;
}

function callDateTime(call) {
  if (!call.started_at_ns) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(new Date(call.started_at_ns / 1e6));
}

function durationLabel(seconds) {
  if (seconds == null) return 'Duration unavailable';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function relativeStatus(call) {
  if (call.critical) return 'Critical';
  if (call.status === 'reviewed') return call.outcome === 'needs_follow_up' ? 'Follow-up' : 'Reviewed';
  if (call.status === 'in_review') return 'In review';
  return 'Unreviewed';
}

function statusClass(call) {
  if (call.critical) return 'critical';
  return call.status === 'reviewed' ? (call.outcome === 'needs_follow_up' ? 'follow-up' : 'reviewed') : call.status;
}

function formatSaved(value) {
  if (!value) return 'Not saved yet';
  return `Saved ${new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function wavBlob(channelData, sampleRate) {
  const channels = channelData.length;
  const sampleCount = channelData[0]?.length || 0;
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + sampleCount * channels * bytesPerSample);
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * channels * bytesPerSample, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * channels * bytesPerSample, true);
  let offset = 44;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, channelData[channel][sample]));
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function artifactUrl(call, bucket, key, download = false) {
  const params = new URLSearchParams({ bucket, date: call.call_date, customer: call.customer, key });
  if (download) params.set('download', '1');
  return `/api/ai-bot-qc/artifact?${params.toString()}`;
}

function eventLabel(event) {
  const labels = {
    claimed: 'claimed this call',
    draft_saved: 'saved review changes',
    reviewed: 'completed the review',
    bulk_reviewed: 'marked reviewed in bulk',
    forwarding_test_completed: 'completed a forwarding test',
    reopened: 'reopened the review',
    claim_expired: 'claim expired',
  };
  return labels[event.event_type] || event.event_type.replaceAll('_', ' ');
}

function SelectField({ value, onChange, label, children }) {
  return (
    <label className="botqc-select-field">
      <span>{label}</span>
      <span className="botqc-select-wrap">
        <select value={value} onChange={onChange}>{children}</select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </label>
  );
}

function SortableHeader({ label, column, sort, onSort }) {
  const direction = sort?.key === column ? sort.direction : null;
  return (
    <th aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
      <button className="botqc-sort-button" type="button" onClick={() => onSort(column)}>
        {label}{direction ? <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span> : <span className="botqc-sort-hint" aria-hidden="true">↕</span>}
      </button>
    </th>
  );
}

function sortRows(rows, sort) {
  if (!sort) return rows;
  const factor = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = left[sort.key];
    const rightValue = right[sort.key];
    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') return (leftValue - rightValue) * factor;
    return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' }) * factor;
  });
}

function matchesQueueText(value, query) {
  const text = String(value || '').toLowerCase();
  if (text.includes(query)) return true;
  const queryDigits = query.replace(/\D/g, '');
  const valueDigits = text.replace(/\D/g, '');
  return queryDigits.length >= 3 && valueDigits.includes(queryDigits);
}

function toggleSort(current, key) {
  return current?.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' };
}

export default function AiBotQc() {
  const { user } = useAuth();
  const userRoles = [user?.role, ...(user?.additionalRoles || [])];
  const isAdmin = userRoles.some(role => ['super_admin', 'ai_bot_qc_admin'].includes(role));
  const [reviewerPreview, setReviewerPreview] = useState(false);
  const showAdminControls = isAdmin && !reviewerPreview;
  const canDownloadRecordings = showAdminControls;
  const [activeView, setActiveView] = useState('queue');
  const [bucket, setBucket] = useState('');
  const [calls, setCalls] = useState([]);
  const [totalCalls, setTotalCalls] = useState(0);
  const [internalTestTotal, setInternalTestTotal] = useState(0);
  const [internalTestInResults, setInternalTestInResults] = useState(0);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardPeriod, setDashboardPeriod] = useState('all');
  const [dashboardReviewer, setDashboardReviewer] = useState('all');
  const [history, setHistory] = useState([]);
  const [bulletinPosts, setBulletinPosts] = useState([]);
  const [bulletinOffset, setBulletinOffset] = useState(0);
  const [bulletinTotal, setBulletinTotal] = useState(0);
  const [bulletinDraft, setBulletinDraft] = useState('');
  const [bulletinTypeDraft, setBulletinTypeDraft] = useState('watch');
  const [bulletinExpiryDraft, setBulletinExpiryDraft] = useState('');
  const [editingBulletin, setEditingBulletin] = useState(false);
  const [savingBulletin, setSavingBulletin] = useState(false);
  const [polishingBulletin, setPolishingBulletin] = useState(false);
  const [bulletinSuggestion, setBulletinSuggestion] = useState('');
  const [forwardingChecks, setForwardingChecks] = useState([]);
  const [forwardingCompleted, setForwardingCompleted] = useState([]);
  const [forwardingCalendar, setForwardingCalendar] = useState('');
  const [forwardingNotes, setForwardingNotes] = useState({});
  const [forwardingResults, setForwardingResults] = useState({});
  const [excludedPhoneNumbers, setExcludedPhoneNumbers] = useState([]);
  const [excludedPhoneInput, setExcludedPhoneInput] = useState('');
  const [excludedLabelInput, setExcludedLabelInput] = useState('');
  const [internalTestFilter, setInternalTestFilter] = useState('hide');
  const [savingExcludedPhone, setSavingExcludedPhone] = useState(false);
  const [downloadingHandbook, setDownloadingHandbook] = useState(false);
  const [forwardingLoading, setForwardingLoading] = useState(false);
  const [completingForwarding, setCompletingForwarding] = useState('');
  const [reopeningForwarding, setReopeningForwarding] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState(null);
  const [openingCall, setOpeningCall] = useState(false);
  const [queueStatus, setQueueStatus] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [queueSort, setQueueSort] = useState(null);
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const debounceRef = useRef(null);
  const searchTimerRef = useRef(null);
  const selectedRef = useRef(null);
  const queueRequestRef = useRef(0);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    let active = true;
    const loadBulletin = () => api.get('/api/ai-bot-qc/bulletin', { params: { limit: 50, offset: bulletinOffset } })
      .then(result => {
        if (!active) return;
        setBulletinPosts(result.data.posts || (result.data.bulletin?.body ? [result.data.bulletin] : []));
        setBulletinTotal(result.data.total ?? result.data.posts?.length ?? 0);
      })
      .catch(() => {});
    loadBulletin();
    const timer = setInterval(loadBulletin, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [bulletinOffset]);

  useEffect(() => {
    const flushOnExit = () => {
      if (selectedRef.current?.previewMode) return;
      const call = selectedRef.current?.call;
      if (!call || call.status === 'reviewed' || call.reviewer_email !== user?.email) return;
      fetch(`/api/ai-bot-qc/calls/${call.id}/release`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: call.feedback || '', call_tags: call.call_tags || [], caller_happiness: call.caller_happiness, critical: Boolean(call.critical), critical_note: call.critical_note || '', outcome: call.outcome }),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flushOnExit);
    return () => window.removeEventListener('pagehide', flushOnExit);
  }, [user?.email]);

  async function loadOverview(nextPeriod = dashboardPeriod, nextReviewer = dashboardReviewer) {
    const [statusResult, dashboardResult] = await Promise.all([
      api.get('/api/ai-bot-qc/status'),
      isAdmin
        ? api.get('/api/ai-bot-qc/dashboard', { params: { period: nextPeriod, reviewer_email: nextReviewer } })
        : api.get('/api/ai-bot-qc/queue-summary'),
    ]);
    setBucket(statusResult.data.bucket || '');
    setDashboard(isAdmin ? dashboardResult.data : { counts: dashboardResult.data.counts || {} });
    setDashboardPeriod(nextPeriod);
    setDashboardReviewer(nextReviewer);
  }

  async function loadForwardingChecks() {
    setForwardingLoading(true);
    try {
      const result = await api.get('/api/ai-bot-qc/forwarding-checks');
      setForwardingChecks(result.data.checks || []);
      setForwardingCompleted(result.data.completed || []);
      setForwardingCalendar(result.data.business_calendar || 'Configured business hours');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load forwarding checks');
    } finally {
      setForwardingLoading(false);
    }
  }

  async function saveExcludedPhoneNumber(phoneNumber, label = '') {
    if (!phoneNumber.trim() || savingExcludedPhone) return false;
    setSavingExcludedPhone(true);
    setError('');
    try {
      const result = await api.post('/api/ai-bot-qc/excluded-phone-numbers', { phone_number: phoneNumber, label });
      setExcludedPhoneNumbers(current => [result.data.number, ...current.filter(number => number.id !== result.data.number.id)]);
      setExcludedPhoneInput('');
      setExcludedLabelInput('');
      await refresh(false);
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add excluded caller number');
      return false;
    } finally {
      setSavingExcludedPhone(false);
    }
  }

  async function addExcludedPhoneNumber(event) {
    event.preventDefault();
    await saveExcludedPhoneNumber(excludedPhoneInput, excludedLabelInput);
  }

  async function deleteExcludedPhoneNumber(number) {
    if (!window.confirm(`Remove ${number.display_phone} from internal test numbers? Its ${number.call_count || 0} calls will no longer be flagged as internal test calls and will count in the queue and reports.`)) return;
    try {
      await api.delete(`/api/ai-bot-qc/excluded-phone-numbers/${number.id}`);
      setExcludedPhoneNumbers(current => current.filter(item => item.id !== number.id));
      await refresh(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove excluded caller number');
    }
  }

  async function downloadTrainingGuide() {
    if (downloadingHandbook) return;
    setDownloadingHandbook(true);
    setError('');
    try {
      const response = await api.get('/api/ai-bot-qc/training-user-guide', { responseType: 'blob' });
      const objectUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'AIRI-QA-Training-and-User-Guide.docx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setError('Could not download the training guide. Ask an administrator to deploy the latest version.');
    } finally {
      setDownloadingHandbook(false);
    }
  }

  async function completeForwardingCheck(check) {
    if (reviewerPreview) return;
    const noteKey = `${check.customer}|${check.last_call_id}`;
    const result = forwardingResults[noteKey];
    if (completingForwarding || !result) return;
    const resultLabel = result === 'reached_airi' ? 'Reached AIRI' : 'Did not reach AIRI';
    if (!window.confirm(`Save “${resultLabel}” for ${accountLabel(check.customer)}?`)) return;
    setCompletingForwarding(check.customer);
    setError('');
    try {
      await api.post(`/api/ai-bot-qc/forwarding-checks/${encodeURIComponent(check.customer)}/complete`, {
        last_call_id: check.last_call_id,
        notes: forwardingNotes[noteKey] || '',
        result,
      });
      setForwardingNotes(current => { const next = { ...current }; delete next[noteKey]; return next; });
      setForwardingResults(current => { const next = { ...current }; delete next[noteKey]; return next; });
      await loadForwardingChecks();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check off the forwarding test');
    } finally {
      setCompletingForwarding('');
    }
  }

  async function reopenForwardingCheck(check) {
    if (reviewerPreview) return;
    if (reopeningForwarding != null) return;
    setReopeningForwarding(check.id);
    setError('');
    try {
      await api.post(`/api/ai-bot-qc/forwarding-checks/${check.id}/reopen`);
      await loadForwardingChecks();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reopen the forwarding check');
    } finally {
      setReopeningForwarding(null);
    }
  }

  async function polishBulletin() {
    if (!bulletinDraft.trim() || polishingBulletin) return;
    setPolishingBulletin(true);
    setBulletinSuggestion('');
    setError('');
    try {
      const result = await api.post('/api/ai-bot-qc/bulletin/polish', { body: bulletinDraft });
      setBulletinSuggestion(result.data.suggestion || '');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not polish the team focus text');
    } finally {
      setPolishingBulletin(false);
    }
  }

  async function loadQueue(nextPage = page, nextStatus = queueStatus, nextQuery = searchText, nextSort = queueSort, nextInternal = internalTestFilter) {
    const requestId = ++queueRequestRef.current;
    const params = { limit: 100, offset: nextPage * 100, internal_tests: nextInternal };
    if (nextStatus === 'critical') params.critical = '1';
    else if (nextStatus !== 'all') params.status = nextStatus;
    if (nextQuery.trim()) params.q = nextQuery.trim();
    if (nextSort) { params.sort_by = nextSort.key; params.sort_dir = nextSort.direction; }
    try {
      const result = await api.get('/api/ai-bot-qc/queue', { params });
      if (requestId === queueRequestRef.current) {
        const total = result.data.total || 0;
        if (!result.data.calls?.length && total > 0 && nextPage > 0) {
          const lastPage = Math.floor((total - 1) / 100);
          setPage(lastPage);
          return loadQueue(lastPage, nextStatus, nextQuery, nextSort, nextInternal);
        }
        setCalls(result.data.calls || []);
        setTotalCalls(total);
        setInternalTestTotal(result.data.internal_test_total || 0);
        setInternalTestInResults(result.data.internal_test_in_results || 0);
        return result.data.calls || [];
      }
      return [];
    } catch (err) {
      if (requestId === queueRequestRef.current) setError(err.response?.data?.error || 'Could not load the QC queue');
      return [];
    }
  }

  async function refresh(sync = false) {
    setLoading(true);
    setError('');
    let refreshedCalls = [];
    try {
      if (sync && bucket) {
        setSyncing(true);
        await api.post('/api/ai-bot-qc/sync', null, { params: { bucket } });
      }
      await loadOverview();
      refreshedCalls = await loadQueue();
      await loadForwardingChecks();
      if (isAdmin) {
        const excludedResult = await api.get('/api/ai-bot-qc/excluded-phone-numbers');
        setExcludedPhoneNumbers(excludedResult.data.numbers || []);
      }
      if (activeView === 'admin-settings' && isAdmin) {
        const result = await api.get('/api/ai-bot-qc/history');
        setHistory(result.data.events || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the QC queue');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
    return refreshedCalls;
  }

  useEffect(() => {
    let active = true;
    async function initialize() {
      setLoading(true);
      try {
        const [statusResult, dashboardResult] = await Promise.all([
          api.get('/api/ai-bot-qc/status'),
          isAdmin
            ? api.get('/api/ai-bot-qc/dashboard', { params: { period: 'all', reviewer_email: 'all' } })
            : api.get('/api/ai-bot-qc/queue-summary'),
        ]);
        if (!active) return;
        setBucket(statusResult.data.bucket || '');
        setDashboard(isAdmin ? dashboardResult.data : { counts: dashboardResult.data.counts || {} });
        // A failed sync must not block the queue from loading.
        await api.post('/api/ai-bot-qc/sync', null, { params: { bucket: statusResult.data.bucket } }).catch(() => {});
        if (!active) return;
        const updatedDashboard = isAdmin
          ? await api.get('/api/ai-bot-qc/dashboard')
          : await api.get('/api/ai-bot-qc/queue-summary');
        if (active) {
          setDashboard(isAdmin ? updatedDashboard.data : { counts: updatedDashboard.data.counts || {} });
          const firstPage = await api.get('/api/ai-bot-qc/queue', { params: { limit: 100, offset: 0 } });
          if (active) {
            setCalls(firstPage.data.calls || []);
            setTotalCalls(firstPage.data.total || 0);
            setInternalTestTotal(firstPage.data.internal_test_total || 0);
          }
          if (active) {
            const forwardingResult = await api.get('/api/ai-bot-qc/forwarding-checks');
            setForwardingChecks(forwardingResult.data.checks || []);
            setForwardingCompleted(forwardingResult.data.completed || []);
            setForwardingCalendar(forwardingResult.data.business_calendar || 'Configured business hours');
          }
          if (active && isAdmin) {
            const excludedResult = await api.get('/api/ai-bot-qc/excluded-phone-numbers');
            setExcludedPhoneNumbers(excludedResult.data.numbers || []);
          }
        }
      } catch (err) {
        if (active) setError(err.response?.data?.error || 'Could not load the QC queue');
      } finally {
        if (active) setLoading(false);
      }
    }
    initialize();
    return () => { active = false; clearTimeout(searchTimerRef.current); };
  }, [isAdmin]);

  useEffect(() => {
    if (activeView !== 'admin-settings' || !isAdmin) return;
    api.get('/api/ai-bot-qc/history')
      .then(result => setHistory(result.data.events || []))
      .catch(err => setError(err.response?.data?.error || 'Could not load admin history'));
  }, [activeView, isAdmin]);

  const activeCallId = selected?.call?.id;
  const activeCallStatus = selected?.call?.status;
  const activeCallReviewer = selected?.call?.reviewer_email;

  useEffect(() => {
    if (!activeCallId || activeCallStatus === 'reviewed' || activeCallReviewer !== user?.email) return undefined;
    const timer = setInterval(async () => {
      if (selectedRef.current?.call?.id !== activeCallId) return;
      try {
        const result = await api.post(`/api/ai-bot-qc/calls/${activeCallId}/claim`);
        setCalls(current => current.map(item => item.id === activeCallId ? { ...item, ...result.data.call } : item));
      } catch (err) {
        setError(err.response?.data?.error || 'The active review lease could not be renewed. Your draft remains saved.');
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [activeCallId, activeCallStatus, activeCallReviewer, user?.email]);

  async function releaseCall(call) {
    if (!call || call.status === 'reviewed' || call.reviewer_email !== user?.email) return;
    clearTimeout(debounceRef.current);
    try {
      const result = await api.post(`/api/ai-bot-qc/calls/${call.id}/release`, {
        feedback: call.feedback || '',
        call_tags: call.call_tags || [],
        caller_happiness: call.caller_happiness,
        critical: Boolean(call.critical),
        critical_note: call.critical_note || '',
        outcome: call.outcome,
      });
      if (result.data.released) {
        setCalls(current => current.map(item => item.id === call.id ? {
          ...item,
          status: 'unreviewed',
          outcome: call.outcome,
          feedback: call.feedback || '',
          call_tags: call.call_tags || [],
          caller_happiness: call.caller_happiness,
          critical: call.critical ? 1 : 0,
          critical_note: call.critical_note || '',
          reviewer_email: user.email,
          reviewer_name: user.name,
          claim_expires_at: null,
          last_saved_at: result.data.saved_at,
        } : item));
      }
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not release this call. Its claim will expire automatically.');
      return false;
    }
  }

  async function closeSelectedCall() {
    const call = selectedRef.current?.call;
    if (call && !selectedRef.current?.previewMode) await releaseCall(call);
    selectedRef.current = null;
    setSelected(null);
    setSelectedId('');
    await Promise.all([loadOverview(), loadQueue(page, queueStatus, searchText)]);
  }

  async function loadSelected(id, options = {}) {
    clearTimeout(debounceRef.current);
    const pendingCall = selectedRef.current?.call;
    if (pendingCall && !selectedRef.current?.previewMode && pendingCall.id !== id && pendingCall.status !== 'reviewed') {
      await releaseCall(pendingCall);
    }
    setSelectedId(id);
    selectedRef.current = null;
    setSelected(null);
    setOpeningCall(true);
    setError('');
    try {
      const queueCall = calls.find(call => call.id === id);
      if (queueCall && queueCall.status !== 'reviewed' && !options.readOnly) {
        await api.post(`/api/ai-bot-qc/calls/${id}/claim`);
        await Promise.all([loadOverview(), loadQueue(page, queueStatus, searchText)]);
      }
      const result = await api.get(`/api/ai-bot-qc/calls/${id}`);
      const selectedData = { ...result.data, previewMode: Boolean(options.readOnly) };
      setSelected(selectedData);
      setSavedAt(selectedData.call.last_saved_at || '');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open this call');
      try {
        const result = await api.get(`/api/ai-bot-qc/calls/${id}`);
        const selectedData = { ...result.data, previewMode: Boolean(options.readOnly) };
        setSelected(selectedData);
        setSavedAt(selectedData.call.last_saved_at || '');
      } catch { setSelected(null); }
    } finally {
      setOpeningCall(false);
    }
  }

  async function saveDraft(next, callId = selectedRef.current?.call?.id) {
    if (!callId) return;
    setSaving(true);
    try {
      const result = await api.put(`/api/ai-bot-qc/calls/${callId}/draft`, next);
      setSavedAt(result.data.saved_at);
      setCalls(current => current.map(call => call.id === callId ? { ...call, ...next, last_saved_at: result.data.saved_at } : call));
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this draft. Keep this call open and retry.');
    } finally {
      setSaving(false);
    }
  }

  function changeDraft(field, value) {
    const current = selectedRef.current;
    if (!current) return;
    const nextCall = {
      ...current.call,
      [field]: value,
      ...(field === 'critical' && value ? { outcome: 'needs_follow_up' } : {}),
    };
    const next = { ...current, call: nextCall };
    selectedRef.current = next;
    setSelected(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveDraft({
      feedback: nextCall.feedback,
      call_tags: nextCall.call_tags || [],
      caller_happiness: nextCall.caller_happiness,
      critical: Boolean(nextCall.critical),
      critical_note: nextCall.critical_note,
      outcome: nextCall.outcome,
    }, nextCall.id), 350);
  }

  async function completeReview() {
    if (!selected?.call) return;
    clearTimeout(debounceRef.current);
    const call = selected.call;
    setSaving(true);
    try {
      const result = await api.post(`/api/ai-bot-qc/calls/${call.id}/complete`, {
        feedback: call.feedback,
        call_tags: call.call_tags || [],
        caller_happiness: call.caller_happiness,
        critical: Boolean(call.critical),
        critical_note: call.critical_note,
        outcome: call.outcome,
      });
      setSavedAt(result.data.reviewed_at);
      const reviewedCall = {
        ...selected,
        call: {
          ...call,
          status: 'reviewed',
          outcome: call.critical ? 'needs_follow_up' : call.outcome,
          call_tags: call.call_tags || [],
          caller_happiness: call.caller_happiness,
          reviewed_at: result.data.reviewed_at,
          last_saved_at: result.data.reviewed_at,
        },
      };
      selectedRef.current = reviewedCall;
      setSelected(reviewedCall);
      const refreshedCalls = await refresh();
      const queueIndex = calls.findIndex(item => item.id === call.id);
      const queueOrder = queueIndex >= 0
        ? [...calls.slice(queueIndex + 1), ...calls.slice(0, queueIndex)]
        : calls;
      const pendingById = new Map(refreshedCalls.filter(item => item.status !== 'reviewed').map(item => [item.id, item]));
      const nextCall = queueOrder.map(item => pendingById.get(item.id)).find(Boolean)
        || refreshedCalls.find(item => item.id !== call.id && item.status !== 'reviewed');
      await loadSelected(nextCall?.id || call.id, nextCall ? {} : { readOnly: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete the review');
    } finally {
      setSaving(false);
    }
  }

  async function reopenReview(callId) {
    try {
      await api.post(`/api/ai-bot-qc/calls/${callId}/reopen`);
      await refresh();
      await loadSelected(callId);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reopen this review');
    }
  }

  function updateQueueStatus(nextStatus) {
    clearTimeout(searchTimerRef.current);
    setQueueStatus(nextStatus);
    setPage(0);
    loadQueue(0, nextStatus, searchText);
  }

  function updateInternalTestFilter(value) {
    clearTimeout(searchTimerRef.current);
    setInternalTestFilter(value);
    setPage(0);
    loadQueue(0, queueStatus, searchText, queueSort, value);
  }

  function updateQueueSearch(value) {
    setSearchText(value);
    setPage(0);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => loadQueue(0, queueStatus, value), 250);
  }

  function updateQueuePage(nextPage) {
    clearTimeout(searchTimerRef.current);
    setPage(nextPage);
    loadQueue(nextPage, queueStatus, searchText);
  }

  function updateQueueSort(key) {
    clearTimeout(searchTimerRef.current);
    const nextSort = queueSort?.key === key
      ? { key, direction: queueSort.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' };
    setQueueSort(nextSort);
    setPage(0);
    loadQueue(0, queueStatus, searchText, nextSort);
  }

  async function saveBulletin() {
    setSavingBulletin(true);
    try {
      await api.post('/api/ai-bot-qc/bulletin', {
        body: bulletinDraft,
        notice_type: bulletinTypeDraft,
        expires_on: bulletinExpiryDraft,
      });
      setBulletinOffset(0);
      const refreshed = await api.get('/api/ai-bot-qc/bulletin', { params: { limit: 50, offset: 0 } });
      setBulletinPosts(refreshed.data.posts || []);
      setBulletinTotal(refreshed.data.total || 0);
      setEditingBulletin(false);
      setBulletinDraft('');
      setBulletinSuggestion('');
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add team focus');
    } finally {
      setSavingBulletin(false);
    }
  }

  function startBulletinEdit() {
    setBulletinDraft('');
    setBulletinSuggestion('');
    setBulletinTypeDraft('watch');
    setBulletinExpiryDraft('');
    setEditingBulletin(true);
  }

  async function deleteBulletinPost(post) {
    if (!window.confirm('Remove this Team focus post? It will disappear for reviewers.')) return;
    try {
      await api.delete(`/api/ai-bot-qc/bulletin/${post.id}`);
      const remainingTotal = Math.max(0, bulletinTotal - 1);
      const nextOffset = bulletinOffset > 0 && bulletinOffset >= remainingTotal ? Math.max(0, bulletinOffset - 50) : bulletinOffset;
      if (nextOffset !== bulletinOffset) setBulletinOffset(nextOffset);
      const refreshed = await api.get('/api/ai-bot-qc/bulletin', { params: { limit: 50, offset: nextOffset } });
      setBulletinPosts(refreshed.data.posts || []);
      setBulletinTotal(refreshed.data.total || 0);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove team focus');
    }
  }

  const pageCount = Math.max(1, Math.ceil(totalCalls / 100));

  const counts = dashboard?.counts || {};
  const summaryCards = [
    { label: 'Unreviewed', value: counts.unreviewed || 0, icon: ListChecks, mood: 'open' },
    { label: 'In progress', value: counts.in_review || 0, icon: Clock3, mood: 'progress' },
    { label: 'Reviewed', value: counts.reviewed || 0, icon: Check, mood: 'done' },
    { label: 'Needs follow-up', value: counts.needs_follow_up || 0, icon: AlertTriangle, mood: 'follow' },
    { label: 'Critical flags', value: counts.critical || 0, icon: ShieldAlert, mood: 'critical' },
  ];

  return (
    <section className="botqc">
      <header className="botqc-header">
        <div>
          <div className="botqc-eyebrow"><AudioLines size={15} /> CALL REVIEW</div>
          <h1 className="botqc-title"><span className="botqc-logo"><img src={airiLogo} alt="AIRI" /></span><span>QA</span></h1>
          <p>Review every call once, keep feedback saved, surface serious issues.</p>
        </div>
        <div className="botqc-header-actions">
          <div className="botqc-bucket-name"><span>Recording archive</span>{bucket || 'Not connected'}</div>
          <button className="botqc-icon-button" onClick={() => refresh(true)} disabled={loading || syncing} title="Sync new recordings" aria-label="Sync new recordings">
            <RefreshCw size={16} className={syncing ? 'botqc-spin' : ''} />
          </button>
        </div>
      </header>

      {error && <div className="botqc-error" role="alert">{error}</div>}

      {reviewerPreview && <div className="botqc-preview-banner" role="status"><span><strong>QA Agent view preview</strong> This is read-only; no review claims or changes will be made.</span><button type="button" onClick={() => { setReviewerPreview(false); setActiveView('admin-settings'); }}>Exit preview</button></div>}

      <nav className="botqc-tabs" aria-label="QC views">
        <button className={activeView === 'queue' ? 'is-active' : ''} onClick={() => { setActiveView('queue'); loadQueue(page, queueStatus, searchText); }}><ListChecks size={15} /> Review queue</button>
        <button className={activeView === 'forwarding' ? 'is-active' : ''} onClick={() => { setActiveView('forwarding'); loadForwardingChecks(); }}><PhoneForwarded size={15} /> Forwarding checks{forwardingChecks.length > 0 ? ` · ${forwardingChecks.length}` : ''}</button>
        {showAdminControls && <button className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}><BarChart3 size={15} /> Team overview</button>}
        {showAdminControls && <button className={activeView === 'admin-settings' ? 'is-active' : ''} onClick={() => setActiveView('admin-settings')}><Settings2 size={15} /> Admin settings</button>}
      </nav>

      {activeView === 'queue' && !selectedId && bulletinPosts.filter(post => !post.is_expired).length > 0 && (
        <section className="botqc-bulletin-list" aria-label="Team focus">
          {bulletinPosts.filter(post => !post.is_expired).slice(0, 3).map((post, index) => (
            <article className={`botqc-bulletin botqc-bulletin--rank-${index + 1}${post.is_recent ? ' botqc-bulletin--recent' : ''}`} key={post.id}>
              <div className="botqc-bulletin-heading"><Megaphone size={15} /><strong>Team focus</strong><span className={`botqc-bulletin-type botqc-bulletin-type--${post.notice_type || 'watch'}`}>{(post.notice_type || 'watch').toUpperCase()}</span>{post.is_recent && <span className="botqc-bulletin-new">NEW</span>}</div>
              <div className="botqc-bulletin-copy"><p>{post.body}</p><small>{post.expires_on ? `Expires ${new Date(`${post.expires_on}T12:00:00`).toLocaleDateString()} · ` : ''}{post.created_by_name ? `Posted by ${post.created_by_name}` : 'Team guidance'}{post.created_at ? ` · ${new Date(post.created_at).toLocaleString()}` : ''}</small></div>
            </article>
          ))}
        </section>
      )}

      {activeView === 'queue' && (
        <>
          <div className="botqc-count-strip">
            {summaryCards.map(({ label, value, icon: Icon, mood }) => (
              <button key={label} className={`botqc-count botqc-count--${mood}`} onClick={() => updateQueueStatus(mood === 'critical' ? 'critical' : mood === 'open' ? 'unreviewed' : mood === 'progress' ? 'in_review' : mood === 'done' ? 'reviewed' : 'all')}>
                <span className="botqc-count-icon"><Icon size={16} /></span>
                <span className="botqc-count-copy"><strong>{value.toLocaleString()}</strong><small>{label}</small></span>
              </button>
            ))}
          </div>

          <div className="botqc-queue-layout">
            <section className="botqc-queue-panel" aria-label="Call review queue">
              <div className="botqc-queue-toolbar">
                <div><h2>Review queue</h2><span>{totalCalls.toLocaleString()} calls{internalTestInResults > 0 ? ` (${internalTestInResults.toLocaleString()} internal test)` : ''}</span></div>
                <div className="botqc-queue-controls">
                  <label className="botqc-search"><Search size={15} /><input value={searchText} onChange={event => updateQueueSearch(event.target.value)} placeholder="Account, caller ID, date, QA Agent" /></label>
                  <SelectField label="Status" value={queueStatus} onChange={event => updateQueueStatus(event.target.value)}>
                    <option value="all">All calls</option><option value="unreviewed">Unreviewed</option><option value="in_review">In progress</option><option value="reviewed">Reviewed</option><option value="critical">Critical</option>
                  </SelectField>
                  {(internalTestTotal > 0 || internalTestFilter !== 'hide') && <SelectField label="Internal tests" value={internalTestFilter} onChange={event => updateInternalTestFilter(event.target.value)}>
                    <option value="hide">Hide</option><option value="include">Include</option><option value="only">Only</option>
                  </SelectField>}
                </div>
              </div>
              <div className="botqc-table-scroll">
                <table className="botqc-queue-table">
                  <thead><tr>
                    <SortableHeader label="Call date / time" column="call_date" sort={queueSort} onSort={updateQueueSort} />
                    <SortableHeader label="Caller ID" column="caller_id" sort={queueSort} onSort={updateQueueSort} />
                    <SortableHeader label="Account" column="account" sort={queueSort} onSort={updateQueueSort} />
                    <SortableHeader label="Status" column="status" sort={queueSort} onSort={updateQueueSort} />
                    <SortableHeader label="QA Agent" column="qa_agent" sort={queueSort} onSort={updateQueueSort} />
                    <SortableHeader label="Duration" column="duration" sort={queueSort} onSort={updateQueueSort} />
                  </tr></thead>
                  <tbody>
                    {calls.map(call => (
                        <tr key={call.id} className={`${selectedId === call.id ? 'is-selected ' : ''}${call.critical ? 'is-critical' : ''}`} onClick={() => loadSelected(call.id, { readOnly: reviewerPreview })}>
                        <td><strong>{callDateTime(call)}</strong><small>{call.room_name || call.room_id}</small></td>
                        <td className="botqc-caller-id">{call.caller_phone ? formatCallerId(call.caller_phone) : <span className="botqc-dash">Not detected</span>}</td>
                        <td className="botqc-account-cell">{accountLabel(call.customer)}{(call.is_internal_test || call.call_tags?.length > 0 || call.caller_happiness) && <div className="botqc-row-tags">{call.is_internal_test && <span className="botqc-internal-test-badge" title={call.internal_test_label || undefined}>Internal test call</span>}{call.caller_happiness && <span title={HAPPINESS_RATINGS.find(rating => rating.value === call.caller_happiness)?.label}>{HAPPINESS_RATINGS.find(rating => rating.value === call.caller_happiness)?.face} Caller sentiment</span>}{call.call_tags?.map(tag => <span key={tag}>{CALL_SIGNAL_FLAGS.find(flag => flag.value === tag)?.shortLabel || tag}</span>)}</div>}</td>
                        <td><span className={`botqc-status botqc-status--${statusClass(call)}`}>{relativeStatus(call)}</span></td>
                        <td>{call.reviewer_name || <span className="botqc-dash">—</span>}{call.status === 'in_review' && call.claim_expires_at && <small>Claim expires {new Date(call.claim_expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}</td>
                        <td className="botqc-duration">{durationLabel(call.duration_seconds)}</td>
                      </tr>
                    ))}
                    {!loading && calls.length === 0 && <tr><td colSpan="6" className="botqc-table-empty">No calls match this queue filter.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="botqc-queue-foot">
                <span>New recordings arrive after sync. Reviews and drafts are saved on this server.</span>
                <div className="botqc-pagination"><button disabled={page === 0} onClick={() => updateQueuePage(Math.max(0, page - 1))}>Previous</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => updateQueuePage(Math.min(pageCount - 1, page + 1))}>Next</button></div>
              </div>
            </section>

            {selectedId && <button className="botqc-review-backdrop" onClick={closeSelectedCall} aria-label="Close call review" />}
            <section className={`botqc-review-panel${selectedId ? ' is-open' : ''}`} aria-label="Selected call review">
              {openingCall && <div className="botqc-opening-call"><span className="botqc-opening-spinner" />Opening call…</div>}
              {!selected ? (
                !openingCall && <div className="botqc-empty"><Headphones size={26} /><strong>Select a call to review</strong><span>Call time and account stay visible in the queue.</span></div>
              ) : (
                <ReviewPanel
                  data={selected}
                  bucket={bucket}
                  isAdmin={showAdminControls}
                  canDownloadRecordings={canDownloadRecordings}
                  previewMode={reviewerPreview}
                  bulletinPosts={bulletinPosts.filter(post => !post.is_expired).slice(0, 3)}
                  viewerEmail={user?.email}
                  saving={saving}
                  savedAt={savedAt}
                  onChange={changeDraft}
                  onComplete={completeReview}
                  onReopen={reopenReview}
                  onClose={closeSelectedCall}
                />
              )}
            </section>
          </div>
        </>
      )}

      {activeView === 'overview' && showAdminControls && <TeamOverview
        dashboard={dashboard}
        period={dashboardPeriod}
        reviewerEmail={dashboardReviewer}
        isAdmin={showAdminControls}
        forwardingChecks={forwardingChecks}
        forwardingCompleted={forwardingCompleted}
        forwardingResults={forwardingResults}
        forwardingNotes={forwardingNotes}
        completingForwarding={completingForwarding}
        onForwardingResultChange={(check, value) => setForwardingResults(current => ({ ...current, [`${check.customer}|${check.last_call_id}`]: value }))}
        onForwardingNoteChange={(check, value) => setForwardingNotes(current => ({ ...current, [`${check.customer}|${check.last_call_id}`]: value }))}
        onCompleteForwarding={completeForwardingCheck}
        onFilterChange={loadOverview}
        onReviewerClick={email => { setQueueStatus('all'); setSearchText(email); setPage(0); setActiveView('queue'); loadQueue(0, 'all', email); }}
      />}

      {activeView === 'admin-settings' && showAdminControls && <AdminSettings
        bulletinPosts={bulletinPosts}
        bulletinOffset={bulletinOffset}
        bulletinTotal={bulletinTotal}
        draft={bulletinDraft}
        type={bulletinTypeDraft}
        expiry={bulletinExpiryDraft}
        editing={editingBulletin}
        saving={savingBulletin}
        polishing={polishingBulletin}
        suggestion={bulletinSuggestion}
        onStartEdit={startBulletinEdit}
        onDraftChange={setBulletinDraft}
        onTypeChange={setBulletinTypeDraft}
        onExpiryChange={setBulletinExpiryDraft}
        onSuggestionChange={setBulletinSuggestion}
        onPolish={polishBulletin}
        onSave={saveBulletin}
        onDeleteBulletinPost={deleteBulletinPost}
        onBulletinPageChange={setBulletinOffset}
        onCancel={() => { setEditingBulletin(false); setBulletinSuggestion(''); }}
        numbers={excludedPhoneNumbers}
        numberInput={excludedPhoneInput}
        numberLabel={excludedLabelInput}
        savingNumber={savingExcludedPhone}
        downloadingHandbook={downloadingHandbook}
        onNumberInputChange={setExcludedPhoneInput}
        onNumberLabelChange={setExcludedLabelInput}
        onAddNumber={addExcludedPhoneNumber}
        onDeleteNumber={deleteExcludedPhoneNumber}
        onDownloadHandbook={downloadTrainingGuide}
        onPreviewReviewer={() => { setReviewerPreview(true); setActiveView('queue'); loadQueue(0, queueStatus, searchText); }}
        history={history}
        onOpenHistoryCall={async id => { setActiveView('queue'); await loadSelected(id, { readOnly: true }); }}
      />}

      {activeView === 'forwarding' && <ForwardingChecks
        checks={forwardingChecks}
        completed={forwardingCompleted}
        calendar={forwardingCalendar}
        loading={forwardingLoading}
        completing={completingForwarding}
        reopening={reopeningForwarding}
        notes={forwardingNotes}
        results={forwardingResults}
        readOnly={reviewerPreview}
        onNoteChange={(check, value) => setForwardingNotes(current => ({ ...current, [`${check.customer}|${check.last_call_id}`]: value }))}
        onResultChange={(check, value) => setForwardingResults(current => ({ ...current, [`${check.customer}|${check.last_call_id}`]: value }))}
        onComplete={completeForwardingCheck}
        onReopen={reopenForwardingCheck}
        onRefresh={loadForwardingChecks}
      />}

    </section>
  );
}

function ReviewPanel({ data, bucket, isAdmin, canDownloadRecordings, bulletinPosts, viewerEmail, previewMode, saving, savedAt, onChange, onComplete, onReopen, onClose }) {
  const call = data.call;
  const files = call.recording_keys || [];
  const editable = !previewMode && call.status !== 'reviewed' && (call.status !== 'in_review' || call.reviewer_email === viewerEmail || isAdmin);
  const hasStructuredReview = Boolean(call.caller_happiness || call.call_tags?.length);
  const readyToComplete = call.critical
    ? Boolean(String(call.critical_note || '').trim())
    : Boolean(hasStructuredReview || String(call.feedback || '').trim());
  const audioFiles = files.filter(key => /\.(ogg|mp3|wav|m4a|opus|webm|aac)$/i.test(key));
  const events = data.history || [];

  return (
    <div className="botqc-review-content">
      <div className="botqc-review-title">
        <div>
          <div className="botqc-review-account">{accountLabel(call.customer)}</div>
          <h2>{callDateTime(call)}</h2>
          <div className="botqc-review-meta">{durationLabel(call.duration_seconds)}{call.room_name ? ` · ${call.room_name}` : ''}</div>
        </div>
        <div className="botqc-review-title-actions">
          {call.is_internal_test && <span className="botqc-internal-test-badge" title={call.internal_test_label || undefined}>Internal test call</span>}
          <span className={`botqc-status botqc-status--${statusClass(call)}`}>{relativeStatus(call)}</span>
          {call.caller_happiness && <span className="botqc-happiness-summary" title={HAPPINESS_RATINGS.find(rating => rating.value === call.caller_happiness)?.label}>{HAPPINESS_RATINGS.find(rating => rating.value === call.caller_happiness)?.face} Caller sentiment</span>}
          <button className="botqc-close-review" onClick={onClose} title="Close review" aria-label="Close review"><X size={17} /></button>
        </div>
      </div>

      <div className="botqc-recordings">
        <div className="botqc-section-heading"><Headphones size={15} /> RECORDING{audioFiles.length === 1 ? '' : 'S'} <span>{audioFiles.length}</span></div>
        {bulletinPosts?.map((post, index) => (
          <div className={`botqc-review-bulletin botqc-review-bulletin--rank-${index + 1}`} key={post.id}>
            <div><Megaphone size={14} /><strong>TEAM FOCUS</strong><span className={`botqc-bulletin-type botqc-bulletin-type--${post.notice_type || 'watch'}`}>{(post.notice_type || 'watch').toUpperCase()}</span>{post.is_recent && <span className="botqc-bulletin-new">NEW</span>}</div>
            <p>{post.body}</p>
          </div>
        ))}
        {audioFiles.length ? audioFiles.map(key => (
          <div className="botqc-audio-row" key={key}>
            <div className="botqc-audio-name"><AudioLines size={15} /><span>{key.split('/').pop()}</span>{canDownloadRecordings && <a className="botqc-download" href={artifactUrl(call, bucket, key, true)} title="Download recording" aria-label={`Download ${key.split('/').pop()}`}><Download size={14} /></a>}</div>
            <DecodedAudioPlayer src={artifactUrl(call, bucket, key)} name={key.split('/').pop()} />
          </div>
        )) : <div className="botqc-data-warning">No linked audio recording was found in the call metadata.</div>}
      </div>

      <section className="botqc-call-metadata">
        <div className="botqc-section-heading">CALL METADATA</div>
        <dl>
          <Metadata label="Account" value={accountLabel(call.customer)} />
          <Metadata label="Started" value={callDateTime(call)} />
          <Metadata label="Duration" value={durationLabel(call.duration_seconds)} />
          {call.room_name && <Metadata label="Room name" value={call.room_name} />}
          {call.room_id && <Metadata label="Room ID" value={call.room_id} />}
          {call.egress_id && <Metadata label="Egress ID" value={call.egress_id} />}
        </dl>
      </section>

      <div className="botqc-review-fields">
        <fieldset className="botqc-happiness" disabled={!editable}>
          <legend>Caller happiness <small>Choose only if the caller’s tone is clear.</small></legend>
          <div className="botqc-happiness-options" role="group" aria-label="Caller happiness rating">
            {HAPPINESS_RATINGS.map(rating => (
              <button key={rating.value} type="button" aria-label={rating.label} aria-pressed={call.caller_happiness === rating.value} title={rating.label} className={`botqc-happiness-choice${call.caller_happiness === rating.value ? ' is-selected' : ''}`} onClick={() => onChange('caller_happiness', call.caller_happiness === rating.value ? null : rating.value)}>
                <span aria-hidden="true">{rating.face}</span><small>{rating.label}</small>
              </button>
            ))}
          </div>
        </fieldset>

        {!call.critical && !hasStructuredReview && <label className="botqc-feedback-field">
          <span>Reviewer notes <small>Optional context; autosaved.</small></span>
          <textarea disabled={!editable} rows="3" maxLength="10000" value={call.feedback || ''} onChange={event => onChange('feedback', event.target.value)} placeholder="Add context that the rating and flags don't capture." />
        </label>}

        <fieldset className="botqc-call-signals" disabled={!editable}>
          <legend>Caller signals <small>Select all that apply; autosaved.</small></legend>
          <div className="botqc-call-signal-options">
            {CALL_SIGNAL_FLAGS.map(flag => (
              <label key={flag.value} className={`botqc-call-signal${(call.call_tags || []).includes(flag.value) ? ' is-selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={(call.call_tags || []).includes(flag.value)}
                  onChange={event => {
                    const tags = new Set(call.call_tags || []);
                    if (event.target.checked) tags.add(flag.value);
                    else tags.delete(flag.value);
                    onChange('call_tags', [...tags]);
                  }}
                />
                <span>{flag.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className={`botqc-critical-toggle${call.critical ? ' is-on' : ''}`}>
          <input type="checkbox" disabled={!editable} checked={Boolean(call.critical)} onChange={event => onChange('critical', event.target.checked)} />
          <span className="botqc-critical-box"><ShieldAlert size={17} /></span>
          <span><strong>Flag critical issue</strong><small>Escalate a serious bot failure for admin attention.</small></span>
        </label>
        {Boolean(call.critical) && (
          <label className="botqc-feedback-field botqc-critical-note">
            <span>Critical issue detail <small>Required to complete; outcome is Needs follow-up.</small></span>
            <textarea disabled={!editable} rows="3" maxLength="2000" value={call.critical_note || ''} onChange={event => onChange('critical_note', event.target.value)} placeholder="Describe the issue and what needs follow-up." />
          </label>
        )}

        <div className="botqc-review-actions">
          <span className={`botqc-save-state${saving ? ' is-saving' : ''}`}><span className="botqc-save-dot" />{saving ? 'Saving…' : formatSaved(savedAt || call.last_saved_at)}</span>
          {call.status !== 'reviewed' ? <button className="botqc-complete-button" disabled={saving || !readyToComplete} onClick={onComplete}>Complete review</button> : (
            <span className="botqc-reviewed-by">Reviewed by {call.reviewer_name || 'Unknown'}{call.reviewed_at ? ` · ${new Date(call.reviewed_at).toLocaleString()}` : ''}</span>
          )}
          {isAdmin && call.status === 'reviewed' && <button className="botqc-reopen-button" onClick={() => onReopen(call.id)}>Reopen review</button>}
        </div>
        {call.status === 'in_review' && call.reviewer_email !== viewerEmail && !isAdmin && <div className="botqc-data-warning">This call is claimed by {call.reviewer_name}. You can view it, but cannot edit until the claim expires.</div>}
        {call.reviewer_name && call.status !== 'reviewed' && <div className="botqc-last-reviewer"><UserRound size={14} /> Last handled by {call.reviewer_name}{call.last_saved_at ? ` · ${new Date(call.last_saved_at).toLocaleString()}` : ''}</div>}
      </div>

      <div className="botqc-call-history">
        <div className="botqc-section-heading"><History size={14} /> CALL HISTORY</div>
        {events.length ? events.slice(0, 8).map((event, index) => (
          <div className="botqc-event" key={`${event.created_at}-${index}`}><span>{event.actor_name}</span><span>{eventLabel(event)}</span><time>{new Date(event.created_at).toLocaleString()}</time></div>
        )) : <div className="botqc-empty-small">No review activity yet.</div>}
      </div>
    </div>
  );
}

function Metadata({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function DecodedAudioPlayer({ src, name }) {
  const [nativeFailed, setNativeFailed] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState('');
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState('');

  useEffect(() => {
    if (!nativeFailed) return undefined;
    const controller = new AbortController();
    let active = true;
    let objectUrl = '';
    async function decodeRecording() {
      setDecoding(true);
      setDecodeError('');
      try {
        const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error(`Recording request failed (${response.status})`);
        const data = new Uint8Array(await response.arrayBuffer());
        const decoder = new OggOpusDecoderWebWorker();
        try {
          await decoder.ready;
          const decoded = await decoder.decodeFile(data);
          objectUrl = URL.createObjectURL(wavBlob(decoded.channelData, decoded.sampleRate));
          if (active) setFallbackUrl(objectUrl);
        } finally {
          await decoder.free();
        }
      } catch (error) {
        if (active && error.name !== 'AbortError') setDecodeError('This recording could not be decoded in the browser.');
      } finally {
        if (active) setDecoding(false);
      }
    }
    decodeRecording();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [nativeFailed, src]);

  return (
    <div className="botqc-audio-player">
      {!nativeFailed && <audio controls preload="metadata" src={src} onError={() => setNativeFailed(true)}>Audio playback is not supported by this browser.</audio>}
      {nativeFailed && (decoding ? <div className="botqc-decoding"><AudioLines size={15} /> Preparing compatible playback…</div> : fallbackUrl ? (
        <audio controls preload="auto" src={fallbackUrl} aria-label={`Play ${name}`} />
      ) : decodeError ? <div className="botqc-data-warning">{decodeError} <a href={src}>Download original</a></div> : null)}
    </div>
  );
}

function TeamOverview({ dashboard, period, reviewerEmail, isAdmin, forwardingChecks, forwardingCompleted, forwardingResults, forwardingNotes, completingForwarding, onForwardingResultChange, onForwardingNoteChange, onCompleteForwarding, onFilterChange, onReviewerClick }) {
  const counts = dashboard?.counts || {};
  const reviewers = dashboard?.reviewers || [];
  const accounts = dashboard?.accounts || [];
  const reviewerOptions = dashboard?.reviewer_options || [];
  const leaderboard = reviewers;
  const tagCounts = dashboard?.tag_counts || {};
  const happinessCounts = dashboard?.caller_happiness_counts || {};
  const botHealth = dashboard?.bot_health || {};
  const feedbackNotes = dashboard?.feedback_notes || [];
  const feedbackNotesCount = dashboard?.feedback_notes_count || 0;
  const issueRate = botHealth.reviewed ? Math.round((botHealth.issueReviews / botHealth.reviewed) * 100) : 0;
  const forwardingActivity = Object.values(forwardingCompleted.reduce((activity, check) => {
    const key = (check.checked_by_email || check.checked_by_name || 'unknown').toLowerCase();
    const reviewer = activity[key] || { name: check.checked_by_name || check.checked_by_email || 'Unknown', total: 0, reached: 0, missed: 0, unrecorded: 0 };
    reviewer.total += 1;
    if (check.result === 'reached_airi') reviewer.reached += 1;
    else if (check.result === 'not_reaching_airi') reviewer.missed += 1;
    else reviewer.unrecorded += 1;
    activity[key] = reviewer;
    return activity;
  }, {})).sort((left, right) => right.total - left.total || left.name.localeCompare(right.name));

  return (
    <div className="botqc-overview">
      <div className="botqc-overview-head">
        <div><h2>Team overview</h2><p>Review counts and caller signals for {period === 'all' ? 'all time' : `the last ${period.slice(0, -1)} days`}{reviewerEmail !== 'all' ? ` · ${reviewerOptions.find(reviewer => reviewer.reviewer_email === reviewerEmail)?.reviewer_name || 'selected QA Agent'}` : ''}.</p></div>
        <div className="botqc-overview-filters">
          <div className="botqc-segmented" aria-label="Review date range">
            {[['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All time']].map(([value, label]) => (
              <button key={value} className={period === value ? 'is-active' : ''} onClick={() => onFilterChange(value, reviewerEmail)}>{label}</button>
            ))}
          </div>
          <SelectField label="QA Agent" value={reviewerEmail} onChange={event => onFilterChange(period, event.target.value)}>
            <option value="all">All QA Agents</option>
            {reviewerOptions.map(reviewer => <option key={reviewer.reviewer_email} value={reviewer.reviewer_email}>{reviewer.reviewer_name || reviewer.reviewer_email}</option>)}
          </SelectField>
        </div>
      </div>
      <div className="botqc-count-strip botqc-count-strip--overview">
        <Metric label="Calls in queue" value={counts.total || 0} icon={ListChecks} />
        <Metric label="Reviewed" value={counts.reviewed || 0} icon={Check} />
        <Metric label="Need follow-up" value={counts.needs_follow_up || 0} icon={AlertTriangle} />
        <Metric label="Critical flags" value={counts.critical || 0} icon={ShieldAlert} critical />
      </div>
      <section className="botqc-health-strip" aria-label="Bot health from reviewed calls">
        <div><strong>Bot health</strong><small>Signals from reviewed calls; not uptime telemetry</small></div>
        <span><b>{botHealth.reviewed || 0}</b> reviewed sample</span>
        <span><b>{issueRate}%</b> issue-flagged</span>
        <span><b>{botHealth.averageHappiness == null ? '—' : `${botHealth.averageHappiness.toFixed(1)}/5`}</b> caller happiness</span>
        <span><b>{botHealth.botHangups || 0}</b> bot-related hang-ups</span>
        <span><b>{botHealth.incorrectInformation || 0}</b> incorrect information</span>
        <span><b>{botHealth.critical || 0}</b> critical</span>
      </section>
      <div className="botqc-signal-counts" aria-label="Caller signal totals">
        <strong>Caller signals</strong>
        {CALL_SIGNAL_FLAGS.map(flag => <span key={flag.value}>{flag.shortLabel}<b>{tagCounts[flag.value] || 0}</b></span>)}
      </div>
      <div className="botqc-signal-counts botqc-happiness-counts" aria-label="Caller happiness distribution">
        <strong>Caller happiness</strong>
        {HAPPINESS_RATINGS.map(rating => <span key={rating.value} title={rating.label}><i aria-hidden="true">{rating.face}</i><b>{happinessCounts[rating.value] || 0}</b></span>)}
      </div>
      <div className="botqc-overview-grid">
        {isAdmin && <>
          <section className="botqc-data-panel">
            <div className="botqc-panel-title"><div><PhoneForwarded size={16} /><h3>Forwarding checks due</h3></div><span>{forwardingChecks.length} due</span></div>
            <div className="botqc-table-scroll">
              <table className="botqc-data-table botqc-forwarding-table">
                <thead><tr><th>Account</th><th>Forward to service</th><th>Main business phone</th><th>VoIP / provider</th><th>Quiet time</th><th>Test result</th><th>Optional note</th><th>Action</th></tr></thead>
                <tbody>
                  {forwardingChecks.map(check => (
                    <tr key={`${check.customer}-${check.last_call_id}`}>
                      <td><HubSpotAccount check={check} /></td>
                      <td>{check.forwarding_number || <span className="botqc-dash">Not provided</span>}</td>
                      <td>{check.main_business_phone || <span className="botqc-dash">Not provided</span>}</td>
                      <td>{check.phone_provider || <span className="botqc-dash">Not provided</span>}</td>
                      <td>{check.business_hours_elapsed}+ business hours</td>
                      <td><select className="botqc-forwarding-result" value={forwardingResults[`${check.customer}|${check.last_call_id}`] || ''} onChange={event => onForwardingResultChange(check, event.target.value)} aria-label={`Test result for ${accountLabel(check.customer)}`}><option value="">Choose result</option><option value="reached_airi">Reached AIRI</option><option value="not_reaching_airi">Did not reach AIRI</option></select></td>
                      <td><textarea className="botqc-forwarding-note" maxLength="1000" rows="2" value={forwardingNotes[`${check.customer}|${check.last_call_id}`] || ''} onChange={event => onForwardingNoteChange(check, event.target.value)} placeholder="Optional note" aria-label={`Optional forwarding-test note for ${accountLabel(check.customer)}`} /></td>
                      <td><button className="botqc-forwarding-complete" disabled={Boolean(completingForwarding) || !forwardingResults[`${check.customer}|${check.last_call_id}`]} onClick={() => onCompleteForwarding(check)}>{completingForwarding === check.customer ? 'Saving…' : <><CheckCheck size={14} /> Save result</>}</button></td>
                    </tr>
                  ))}
                  {!forwardingChecks.length && <tr><td colSpan="8" className="botqc-table-empty">No forwarding tests are due.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="botqc-data-panel">
            <div className="botqc-panel-title"><div><BarChart3 size={16} /><h3>Forwarding check leaderboard</h3></div><span>Last 30 days</span></div>
            <div className="botqc-table-scroll">
              <table className="botqc-data-table">
                <thead><tr><th>#</th><th>Checked by</th><th>Total</th><th>Reached AIRI</th><th>Did not reach</th><th>Not recorded</th></tr></thead>
                <tbody>
                  {forwardingActivity.map((reviewer, index) => (
                    <tr key={reviewer.name}>
                      <td className="botqc-rank">{index + 1}</td>
                      <td>{reviewer.name}</td><td><strong>{reviewer.total}</strong></td>
                      <td>{reviewer.reached}</td><td>{reviewer.missed}</td><td>{reviewer.unrecorded}</td>
                    </tr>
                  ))}
                  {!forwardingActivity.length && <tr><td colSpan="6" className="botqc-table-empty">No forwarding tests completed recently.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>}
      </div>
      <div className="botqc-overview-grid">
        <section className="botqc-data-panel">
          <div className="botqc-panel-title"><div><BarChart3 size={16} /><h3>QA Agent leaderboard</h3></div><span>{period === 'all' ? 'All time' : `Last ${period.slice(0, -1)} days`}</span></div>
          <div className="botqc-table-scroll">
            <table className="botqc-data-table">
              <thead><tr><th>#</th><th>QA Agent</th><th>Reviews</th><th>Avg. caller happiness</th><th>Follow-up</th><th>Critical</th></tr></thead>
              <tbody>
                {leaderboard.map((reviewer, index) => (
                  <tr key={reviewer.reviewer_email}>
                    <td className="botqc-rank">{index + 1}</td>
                    <td><button className="botqc-text-button" onClick={() => onReviewerClick(reviewer.reviewer_email)}>{reviewer.reviewer_name}</button><small>{reviewer.last_reviewed_at ? `Last review ${new Date(reviewer.last_reviewed_at).toLocaleDateString()}` : ''}</small></td>
                    <td><strong>{reviewer.completed || 0}</strong></td>
                    <td>{reviewer.avg_caller_happiness == null ? '—' : `${reviewer.avg_caller_happiness.toFixed(1)}/5`}<small>{reviewer.rated_calls || 0} rated</small></td>
                    <td>{reviewer.issues_found || 0}</td>
                    <td>{reviewer.critical_found || 0}</td>
                  </tr>
                ))}
                {!leaderboard.length && <tr><td colSpan="6" className="botqc-table-empty">No completed reviews yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="botqc-panel-foot">Ranked by completed reviews. Issue reporting is shown for context, not used to penalize QA Agents.</p>
        </section>

        <section className="botqc-data-panel">
          <div className="botqc-panel-title"><div><BarChart3 size={16} /><h3>Bot health by account</h3></div><span>Signals from reviewed calls</span></div>
          <div className="botqc-table-scroll">
            <table className="botqc-data-table">
              <thead><tr><th>Account</th><th>Reviewed</th><th>Issue rate</th><th>Happiness</th><th>Bot hang-up</th><th>Misunderstood</th><th>Wrong info</th><th>Handoff</th><th>Greeting only</th><th>No interaction</th><th>Sales / spam</th><th>Critical</th></tr></thead>
              <tbody>
                {accounts.map(account => (
                  <tr key={account.customer}>
                    <td>{accountLabel(account.customer)}</td>
                    <td>{account.reviewed || 0}</td>
                    <td>{account.reviewed ? `${Math.round((account.issues / account.reviewed) * 100)}%` : '—'}<small>{account.issues || 0} flagged</small></td>
                    <td>{account.avg_caller_happiness == null ? '—' : `${account.avg_caller_happiness.toFixed(1)}/5`}<small>{account.rated_calls || 0} rated</small></td>
                    <td>{account.bot_hangups || 0}</td>
                    <td>{account.intent_misunderstood || 0}</td>
                    <td>{account.incorrect_information || 0}</td>
                    <td>{account.handoff_needed || 0}</td>
                    <td>{account.greeting_only || 0}</td>
                    <td>{account.no_interaction || 0}</td>
                    <td>{account.sales_spam || 0}</td>
                    <td>{account.critical || 0}</td>
                  </tr>
                ))}
                {!accounts.length && <tr><td colSpan="12" className="botqc-table-empty">No account data yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="botqc-panel-foot">Issue counts are paired with reviewed-call counts for fair comparison. Date range and QA Agent filters apply to these tables; top-line queue counts remain global.</p>
        </section>
      </div>
      <div className="botqc-overview-grid">
        <section className="botqc-data-panel">
          <div className="botqc-panel-title"><div><History size={16} /><h3>QA feedback notes</h3></div><span>Latest {feedbackNotes.length} of {feedbackNotesCount}</span></div>
          <div className="botqc-feedback-list">
            {feedbackNotes.map((note, index) => (
              <article className="botqc-feedback-note" key={`${note.reviewer_email}-${note.reviewed_at}-${index}`}>
                <div><strong>{accountLabel(note.customer)}</strong><span>{note.reviewer_name || note.reviewer_email}</span><time>{note.reviewed_at ? new Date(note.reviewed_at).toLocaleString() : ''}</time></div>
                <p>{note.feedback}</p>
                <div className="botqc-row-tags">{note.caller_happiness && <span>{HAPPINESS_RATINGS.find(rating => rating.value === note.caller_happiness)?.face} Caller sentiment</span>}{note.critical ? <span className="is-critical">Critical</span> : null}{note.call_tags.map(tag => <span key={tag}>{CALL_SIGNAL_FLAGS.find(flag => flag.value === tag)?.shortLabel || tag}</span>)}</div>
              </article>
            ))}
            {!feedbackNotes.length && <div className="botqc-empty-small">No written reviewer notes in this range. Structured ratings and flags are summarized above.</div>}
          </div>
        </section>

      </div>
    </div>
  );
}

function AdminSettings({ bulletinPosts, bulletinOffset, bulletinTotal, draft, type, expiry, editing, saving, polishing, suggestion, onStartEdit, onDraftChange, onTypeChange, onExpiryChange, onSuggestionChange, onPolish, onSave, onCancel, onDeleteBulletinPost, onBulletinPageChange, numbers, numberInput, numberLabel, savingNumber, downloadingHandbook, onNumberInputChange, onNumberLabelChange, onAddNumber, onDeleteNumber, onDownloadHandbook, history, onOpenHistoryCall, onPreviewReviewer }) {
  const bulletinPageSize = 50;
  const bulletinPage = Math.floor(bulletinOffset / bulletinPageSize);
  const bulletinPageCount = Math.max(1, Math.ceil(bulletinTotal / bulletinPageSize));
  return (
    <div className="botqc-overview">
      <div className="botqc-overview-head"><div><h2>Admin settings</h2><p>Manage guidance and internal test numbers for the review team.</p></div><button className="botqc-complete-button botqc-reviewer-preview-button" type="button" onClick={onPreviewReviewer}><Headphones size={14} /> View as QA Agent</button></div>
      <section className="botqc-data-panel botqc-admin-settings-panel">
        <div className="botqc-panel-title"><div><Megaphone size={16} /><h3>Team focus posts</h3></div><span>Showing {bulletinPosts.length} of {bulletinTotal} posts</span></div>
        <p className="botqc-panel-foot">Add posts without replacing existing guidance. The three newest active posts are highlighted for reviewers. Posts marked NEW were added in the last seven days.</p>
        {editing ? (
          <div className="botqc-bulletin-editor botqc-admin-settings-editor">
            <div className="botqc-bulletin-options">
              <label><span>Type</span><select value={type} onChange={event => onTypeChange(event.target.value)}><option value="bug">Bug</option><option value="watch">Watch</option><option value="test">Test</option></select></label>
              <label><span>Expires</span><input type="date" min={new Date().toISOString().slice(0, 10)} value={expiry} onChange={event => onExpiryChange(event.target.value)} /></label>
            </div>
            <textarea maxLength="2000" rows="5" value={draft} onChange={event => onDraftChange(event.target.value)} placeholder="Recent bugs, things to watch for, or a specific test to run…" />
            {suggestion && <div className="botqc-bulletin-suggestion"><strong>AI suggestion</strong><p>{suggestion}</p><div><button className="botqc-bulletin-cancel" onClick={() => onSuggestionChange('')}>Dismiss</button><button className="botqc-bulletin-use" onClick={() => { onDraftChange(suggestion); onSuggestionChange(''); }}>Use suggestion</button></div></div>}
            <div className="botqc-bulletin-actions"><span>{draft.length}/2000</span><button className="botqc-bulletin-polish" onClick={onPolish} disabled={saving || polishing || !draft.trim()}>{polishing ? 'Polishing…' : 'Polish with AI'}</button><button className="botqc-bulletin-cancel" onClick={onCancel} disabled={saving}>Cancel</button><button className="botqc-complete-button" onClick={onSave} disabled={saving || !draft.trim()}>{saving ? 'Saving…' : 'Add team focus'}</button></div>
          </div>
        ) : (
          <div className="botqc-admin-settings-preview"><button className="botqc-bulletin-edit" onClick={onStartEdit}>Add team focus</button></div>
        )}
        <div className="botqc-admin-bulletin-list">
          {bulletinPosts.map((post, index) => {
            const rank = Math.floor(bulletinOffset / bulletinPageSize) * bulletinPageSize + index + 1;
            return <article className={`botqc-admin-bulletin-post botqc-admin-bulletin-post--rank-${rank}${post.is_recent ? ' is-recent' : ''}`} key={post.id}>
              <div className="botqc-bulletin-heading"><span className={`botqc-bulletin-type botqc-bulletin-type--${post.notice_type || 'watch'}`}>{(post.notice_type || 'watch').toUpperCase()}</span>{post.is_recent && <span className="botqc-bulletin-new">NEW</span>}{post.is_expired && <span className="botqc-dash">Expired</span>}<button className="botqc-icon-button botqc-excluded-phone-delete" type="button" onClick={() => onDeleteBulletinPost(post)} title="Delete this Team focus post" aria-label="Delete this Team focus post"><Trash2 size={14} /></button></div>
              <p>{post.body}</p>
              <small>{post.expires_on ? `Expires ${new Date(`${post.expires_on}T12:00:00`).toLocaleDateString()} · ` : ''}{post.created_by_name ? `Posted by ${post.created_by_name}` : 'Team focus'}{post.created_at ? ` · ${new Date(post.created_at).toLocaleString()}` : ''}</small>
            </article>;
          })}
          {!bulletinPosts.length && <p className="botqc-empty-small">No Team focus posts yet. Add one above to share guidance with reviewers.</p>}
        </div>
        {bulletinTotal > bulletinPageSize && <div className="botqc-queue-foot"><span>Showing {bulletinOffset + 1}–{Math.min(bulletinOffset + bulletinPosts.length, bulletinTotal)} of {bulletinTotal} active posts</span><div className="botqc-pagination"><button type="button" disabled={bulletinPage === 0} onClick={() => onBulletinPageChange(Math.max(0, bulletinOffset - bulletinPageSize))}>Previous</button><span>{bulletinPage + 1} / {bulletinPageCount}</span><button type="button" disabled={bulletinPage + 1 >= bulletinPageCount} onClick={() => onBulletinPageChange(bulletinOffset + bulletinPageSize)}>Next</button></div></div>}
      </section>
      <section className="botqc-data-panel botqc-guide-download-panel">
        <div className="botqc-panel-title"><div><Download size={16} /><h3>AIRI QA Training &amp; User Guide</h3></div><span>For QA Agents and admins</span></div>
        <div className="botqc-guide-download-content">
          <p>Download the current plain-language guide for call reviews, forwarding checks, and team training.</p>
          <button className="botqc-complete-button botqc-handbook-download" type="button" onClick={onDownloadHandbook} disabled={downloadingHandbook}><Download size={14} /> {downloadingHandbook ? 'Preparing…' : 'Download training & user guide'}</button>
        </div>
      </section>
      <InternalTestCallers
        numbers={numbers}
        input={numberInput}
        label={numberLabel}
        saving={savingNumber}
        onInputChange={onNumberInputChange}
        onLabelChange={onNumberLabelChange}
        onAdd={onAddNumber}
        onDelete={onDeleteNumber}
      />
      <AdminHistory events={history} onOpen={onOpenHistoryCall} />
    </div>
  );
}

function InternalTestCallers({ numbers, input, label, saving, onInputChange, onLabelChange, onAdd, onDelete }) {
  return (
    <div className="botqc-overview">
      <div className="botqc-overview-head">
        <div><h2>Internal test numbers</h2><p>Any call from a number listed here is automatically flagged as an Internal test call, including past calls. Flagged calls are hidden from the Review queue by default (use the Internal tests filter to see them) and are left out of counts, reports, and forwarding checks.</p></div>
      </div>
      <section className="botqc-data-panel botqc-excluded-phones-panel">
        <div className="botqc-panel-title"><div><PhoneForwarded size={16} /><h3>Internal test numbers</h3></div><span>Shared globally · {numbers.length}</span></div>
        <form className="botqc-excluded-phone-form" onSubmit={onAdd}>
          <label htmlFor="botqc-excluded-phone">Phone number</label>
          <input id="botqc-excluded-phone" type="tel" autoComplete="tel" value={input} onChange={event => onInputChange(event.target.value)} placeholder="e.g. +1 212 555 0123" maxLength="40" required />
          <input aria-label="Label (optional)" value={label} onChange={event => onLabelChange(event.target.value)} placeholder="Label, e.g. Support team test line" maxLength="80" />
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add number'}</button>
        </form>
        <div className="botqc-table-scroll">
          <table className="botqc-data-table botqc-excluded-phones-table">
            <thead><tr><th>Phone number</th><th>Label</th><th>Calls flagged</th><th>Added by</th><th>Added</th><th /></tr></thead>
            <tbody>
              {numbers.map(number => (
                <tr key={number.id}>
                  <td><strong>{number.display_phone}</strong></td>
                  <td>{number.label || '—'}</td>
                  <td>{(number.call_count || 0).toLocaleString()}</td>
                  <td>{number.created_by_name}</td>
                  <td>{new Date(number.created_at).toLocaleDateString()}</td>
                  <td><button className="botqc-icon-button botqc-excluded-phone-delete" type="button" onClick={() => onDelete(number)} title={`Remove ${number.display_phone}`} aria-label={`Remove ${number.display_phone} from internal test numbers`}><Trash2 size={14} /></button></td>
                </tr>
              ))}
              {!numbers.length && <tr><td colSpan="6" className="botqc-table-empty">No internal test numbers have been added.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, icon: Icon, critical }) {
  return <div className={`botqc-count${critical ? ' botqc-count--critical' : ''}`}><span className="botqc-count-icon"><Icon size={16} /></span><span className="botqc-count-copy"><strong>{Number(value).toLocaleString()}</strong><small>{label}</small></span></div>;
}

function ForwardingChecks({ checks, completed, calendar, loading, completing, reopening, notes, results, readOnly, onNoteChange, onResultChange, onComplete, onReopen, onRefresh }) {
  const [dueQuery, setDueQuery] = useState('');
  const [dueSort, setDueSort] = useState(null);
  const [completedQuery, setCompletedQuery] = useState('');
  const [completedResult, setCompletedResult] = useState('all');
  const [completedSort, setCompletedSort] = useState(null);
  const normalizedDueQuery = dueQuery.trim().toLowerCase();
  const visibleChecks = sortRows(checks.filter(check => !normalizedDueQuery || [
    check.customer, check.forwarding_number, check.main_business_phone, check.phone_provider,
  ].some(value => matchesQueueText(value, normalizedDueQuery))), dueSort);
  const normalizedCompletedQuery = completedQuery.trim().toLowerCase();
  const visibleCompleted = sortRows(completed.filter(check => {
    const resultMatches = completedResult === 'all' || check.result === completedResult || (completedResult === 'not_recorded' && !check.result);
    const queryMatches = !normalizedCompletedQuery || [check.customer, check.checked_by_name, check.notes, check.result]
      .some(value => matchesQueueText(value, normalizedCompletedQuery));
    return resultMatches && queryMatches;
  }), completedSort);
  const changeDueSort = key => setDueSort(current => toggleSort(current, key));
  const changeCompletedSort = key => setCompletedSort(current => toggleSort(current, key));

  return (
    <div className="botqc-overview">
      <div className="botqc-overview-head">
        <div><h2>Forwarding checks</h2><p>Place a test call and verify forwarding for accounts that have been quiet for 36 business hours.</p></div>
        <button className="botqc-icon-button" onClick={onRefresh} disabled={loading} title="Refresh forwarding checks" aria-label="Refresh forwarding checks"><RefreshCw size={15} className={loading ? 'botqc-spin' : ''} /></button>
      </div>
      <section className="botqc-data-panel botqc-forwarding-panel">
        <div className="botqc-panel-title"><div><PhoneForwarded size={16} /><h3>Accounts to test</h3></div><span>{visibleChecks.length}{dueQuery ? ` of ${checks.length}` : ''} due</span></div>
        <div className="botqc-queue-filters"><label className="botqc-search"><Search size={14} /><input value={dueQuery} onChange={event => setDueQuery(event.target.value)} placeholder="Search account or phone" aria-label="Filter forwarding checks due" /></label></div>
        <div className="botqc-table-scroll">
          <table className="botqc-data-table botqc-forwarding-table">
            <thead><tr>
              <SortableHeader label="Account" column="customer" sort={dueSort} onSort={changeDueSort} />
              <SortableHeader label="Forward to service" column="forwarding_number" sort={dueSort} onSort={changeDueSort} />
              <SortableHeader label="Main business phone" column="main_business_phone" sort={dueSort} onSort={changeDueSort} />
              <SortableHeader label="VoIP / provider" column="phone_provider" sort={dueSort} onSort={changeDueSort} />
              <SortableHeader label="Last call" column="last_call_at" sort={dueSort} onSort={changeDueSort} />
              <SortableHeader label="Quiet time" column="business_hours_elapsed" sort={dueSort} onSort={changeDueSort} />
              <th>Test result</th><th>Optional note</th><th>Action</th>
            </tr></thead>
            <tbody>
              {visibleChecks.map(check => (
                <tr key={`${check.customer}-${check.last_call_id}`}>
                  <td><HubSpotAccount check={check} /></td>
                  <td>{check.forwarding_number || <span className="botqc-dash">Not in HubSpot</span>}</td>
                  <td>{check.main_business_phone || <span className="botqc-dash">Not provided</span>}</td>
                  <td>{check.phone_provider || <span className="botqc-dash">Not in HubSpot</span>}</td>
                  <td>{new Date(check.last_call_at).toLocaleString()}</td>
                  <td>{check.business_hours_elapsed}+ business hours</td>
                  <td><select className="botqc-forwarding-result" value={results[`${check.customer}|${check.last_call_id}`] || ''} disabled={readOnly} onChange={event => onResultChange(check, event.target.value)} aria-label={`Test result for ${accountLabel(check.customer)}`}><option value="">Choose result</option><option value="reached_airi">Reached AIRI</option><option value="not_reaching_airi">Did not reach AIRI</option></select></td>
                  <td><textarea className="botqc-forwarding-note" maxLength="1000" rows="2" value={notes[`${check.customer}|${check.last_call_id}`] || ''} disabled={readOnly} onChange={event => onNoteChange(check, event.target.value)} placeholder="What did you test? Any issue?" aria-label={`Optional forwarding-test note for ${accountLabel(check.customer)}`} /></td>
                  <td><button className="botqc-forwarding-complete" disabled={readOnly || Boolean(completing) || !results[`${check.customer}|${check.last_call_id}`]} onClick={() => onComplete(check)}>{completing === check.customer ? 'Saving…' : <><CheckCheck size={14} /> Save result</>}</button></td>
                </tr>
              ))}
              {!loading && !visibleChecks.length && <tr><td colSpan="9" className="botqc-table-empty">{checks.length ? 'No due checks match this filter.' : 'No forwarding tests are due.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="botqc-panel-foot">Business calendar: {calendar}. A completed test is recorded against the latest call; another quiet period opens a new task.</p>
      </section>

      <section className="botqc-data-panel botqc-forwarding-panel">
        <div className="botqc-panel-title"><div><History size={16} /><h3>Recently completed</h3></div><span>Last 30 days · {visibleCompleted.length}{completedQuery || completedResult !== 'all' ? ` of ${completed.length}` : ''}</span></div>
        <div className="botqc-queue-filters botqc-queue-filters--completed"><label className="botqc-search"><Search size={14} /><input value={completedQuery} onChange={event => setCompletedQuery(event.target.value)} placeholder="Search account, QA Agent, or note" aria-label="Filter completed forwarding checks" /></label><SelectField label="Result" value={completedResult} onChange={event => setCompletedResult(event.target.value)}><option value="all">All results</option><option value="reached_airi">Reached AIRI</option><option value="not_reaching_airi">Did not reach AIRI</option><option value="not_recorded">Not recorded</option></SelectField></div>
        <div className="botqc-table-scroll">
          <table className="botqc-data-table botqc-forwarding-completed-table">
            <thead><tr>
              <SortableHeader label="Account" column="customer" sort={completedSort} onSort={changeCompletedSort} />
              <SortableHeader label="Tested" column="checked_at" sort={completedSort} onSort={changeCompletedSort} />
              <SortableHeader label="QA Agent" column="checked_by_name" sort={completedSort} onSort={changeCompletedSort} />
              <SortableHeader label="Result" column="result" sort={completedSort} onSort={changeCompletedSort} />
              <SortableHeader label="Note" column="notes" sort={completedSort} onSort={changeCompletedSort} />
              <th />
            </tr></thead>
            <tbody>
              {visibleCompleted.map(check => (
                <tr key={check.id}>
                  <td><HubSpotAccount check={check} /></td>
                  <td>{new Date(check.checked_at).toLocaleString()}</td>
                  <td>{check.checked_by_name}</td>
                  <td><span className={`botqc-status ${check.result === 'reached_airi' ? 'botqc-status--reviewed' : check.result === 'not_reaching_airi' ? 'botqc-status--critical' : ''}`}>{check.result === 'reached_airi' ? 'Reached AIRI' : check.result === 'not_reaching_airi' ? 'Did not reach AIRI' : 'Not recorded'}</span></td>
                  <td className="botqc-forwarding-completed-note">{check.notes || <span className="botqc-dash">—</span>}</td>
                  <td><button className="botqc-reopen-button" disabled={readOnly || reopening != null} onClick={() => onReopen(check)}>{reopening === check.id ? 'Reopening…' : 'Reopen'}</button></td>
                </tr>
              ))}
              {!loading && !visibleCompleted.length && <tr><td colSpan="6" className="botqc-table-empty">{completed.length ? 'No completed checks match these filters.' : 'No forwarding tests completed in the last 30 days.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="botqc-panel-foot">Use Reopen if a test was checked off by mistake; it will return to the due queue when the latest call still qualifies.</p>
      </section>
    </div>
  );
}

function AdminHistory({ events, onOpen }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null);
  const normalizedQuery = query.trim().toLowerCase();
  const rows = sortRows(events.map(event => ({ ...event, details_text: JSON.stringify(event.details || {}) })).filter(event => !normalizedQuery || [
    event.customer, event.actor_name, event.event_type, event.object_key, event.details_text,
  ].some(value => String(value || '').toLowerCase().includes(normalizedQuery))), sort);
  const changeSort = key => setSort(current => toggleSort(current, key));

  return (
    <section className="botqc-data-panel botqc-history-panel">
      <div className="botqc-panel-title"><div><History size={16} /><h3>Admin audit history</h3></div><span>{rows.length}{query ? ` of ${events.length}` : ''} events</span></div>
      <div className="botqc-queue-filters"><label className="botqc-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search account, QA Agent, or action" aria-label="Filter admin history" /></label></div>
      <div className="botqc-table-scroll">
        <table className="botqc-data-table botqc-history-table">
          <thead><tr>
            <SortableHeader label="When" column="created_at" sort={sort} onSort={changeSort} />
            <SortableHeader label="Call" column="started_at_ns" sort={sort} onSort={changeSort} />
            <SortableHeader label="Account" column="customer" sort={sort} onSort={changeSort} />
            <SortableHeader label="QA Agent" column="actor_name" sort={sort} onSort={changeSort} />
            <SortableHeader label="Action" column="event_type" sort={sort} onSort={changeSort} />
            <SortableHeader label="Details" column="details_text" sort={sort} onSort={changeSort} />
          </tr></thead>
          <tbody>
            {rows.map((event, index) => (
              <tr key={`${event.id}-${index}`}>
                <td>{new Date(event.created_at).toLocaleString()}</td>
                <td><button className="botqc-text-button" onClick={() => onOpen(event.call_id)}>{event.started_at_ns ? callDateTime(event) : event.object_key.split('/').at(-1)}</button></td>
                <td>{accountLabel(event.customer)}</td><td>{event.actor_name}</td><td>{eventLabel(event)}</td>
                <td>{event.details?.outcome ? (event.details.outcome === 'ok' ? 'OK' : 'Needs follow-up') : event.details?.critical ? 'Critical flag set' : ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="6" className="botqc-table-empty">{events.length ? 'No history events match this filter.' : 'No review events yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
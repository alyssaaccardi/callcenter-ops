import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import api from '../api';
import { useAuth } from './AuthContext';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const { user, loading } = useAuth();
  // AIRI Interns only see recording links; skip dashboard polling (the server would 403 it).
  const userRoles = [user?.role, ...(user?.additionalRoles || [])].filter(Boolean);
  const pollingEnabled = !loading && !(userRoles.length > 0 && userRoles.every(role => role === 'ai_bot_qc_intern'));
  const [slackConfig, setSlackConfig] = useState({ didsUnavailable: '', didsAvailable: '', savvyActive: '', savvyInactive: '' });
  const [status, setStatus] = useState(null);
  const [didCounts, setDidCounts] = useState(null);
  const [hubspotDids, setHubspotDids] = useState(null);
  const [activityLog, setActivityLog] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('ccob_dark') === '1');

  useEffect(() => {
    document.body.classList.toggle('dark', darkMode);
    localStorage.setItem('ccob_dark', darkMode ? '1' : '0');
  }, [darkMode]);

  const toast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  useEffect(() => {
    if (!pollingEnabled) return;
    api.get('/api/activity-log').then(res => setActivityLog(res.data || [])).catch(() => {});
  }, [pollingEnabled]);

  const addLog = useCallback((msg, type = 'info') => {
    const entry = {
      time: new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
        hour12: true, timeZone: 'America/New_York',
      }) + ' EST',
      user: user?.name || '',
      msg,
      type: type || 'info',
    };
    setActivityLog(prev => [entry, ...prev].slice(0, 500));
    api.post('/api/activity-log', { msg, type, user: entry.user }).catch(() => {});
  }, [user]);

  // Load Slack config from authenticated endpoint
  useEffect(() => {
    if (!pollingEnabled) return;
    api.get('/api/slack-config').then(res => {
      setSlackConfig(res.data || {});
    }).catch(() => {});
  }, [pollingEnabled]);

  // Poll /api/status every 15s
  useEffect(() => {
    const fetchStatus = () => {
      axios.get('/api/status').then(res => setStatus(res.data)).catch(() => {});
    };
    if (!pollingEnabled) return undefined;
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [pollingEnabled]);

  // Poll /api/bandwidth/dids every 30s
  useEffect(() => {
    const fetchDids = () => {
      axios.get('/api/bandwidth/dids').then(res => setDidCounts(res.data)).catch(() => {});
    };
    if (!pollingEnabled) return undefined;
    fetchDids();
    const interval = setInterval(fetchDids, 30000);
    return () => clearInterval(interval);
  }, [pollingEnabled]);

  // Poll /api/hubspot/dids every 60s
  useEffect(() => {
    const fetchHsDids = () => {
      axios.get('/api/hubspot/dids').then(res => setHubspotDids(res.data)).catch(() => {});
    };
    if (!pollingEnabled) return undefined;
    fetchHsDids();
    const interval = setInterval(fetchHsDids, 60000);
    return () => clearInterval(interval);
  }, [pollingEnabled]);

  return (
    <AppContext.Provider value={{
      slackConfig,
      status, setStatus,
      didCounts,
      hubspotDids,
      activityLog, addLog,
      toasts, toast,
      darkMode, setDarkMode,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

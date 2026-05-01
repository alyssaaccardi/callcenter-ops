import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import api from '../api';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [slackConfig, setSlackConfig] = useState({ didsUnavailable: '', didsAvailable: '', savvyActive: '', savvyInactive: '' });
  const [status, setStatus] = useState(null);
  const [didCounts, setDidCounts] = useState(null);
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

  const addLog = useCallback((msg, type = 'info') => {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg,
      type,
    };
    setActivityLog(prev => [entry, ...prev].slice(0, 100));
  }, []);

  // Load Slack config from authenticated endpoint
  useEffect(() => {
    api.get('/api/slack-config').then(res => {
      setSlackConfig(res.data || {});
    }).catch(() => {});
  }, []);

  // Poll /api/status every 15s
  useEffect(() => {
    const fetchStatus = () => {
      axios.get('/api/status').then(res => setStatus(res.data)).catch(() => {});
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  // Poll /api/bandwidth/dids every 30s
  useEffect(() => {
    const fetchDids = () => {
      axios.get('/api/bandwidth/dids').then(res => setDidCounts(res.data)).catch(() => {});
    };
    fetchDids();
    const interval = setInterval(fetchDids, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <AppContext.Provider value={{
      slackConfig,
      status, setStatus,
      didCounts,
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

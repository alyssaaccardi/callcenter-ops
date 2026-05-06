import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/layout/Sidebar';
import Topbar from './components/layout/Topbar';
import Toast from './components/layout/Toast';
import StatusBoard from './modules/StatusBoard';
import SmsModule from './modules/SmsModule';
import SlackWorkflows from './modules/SlackWorkflows';
import AgentBoard from './modules/AgentBoard';
import Settings from './modules/Settings';
import MobilePage from './pages/MobilePage';
import LoginPage from './pages/LoginPage';
import DialedInPage from './pages/DialedInPage';
import PulsePage from './pages/PulsePage';

function Dashboard() {
  const [activeModule, setActiveModule] = useState('status');
  const { user } = useAuth();

  if (user?.role === 'tv_display') return <Navigate to="/dialed-in" replace />;

  const moduleMap = {
    status:   <StatusBoard />,
    sms:      <SmsModule />,
    slack:    <SlackWorkflows />,
    monday:   <AgentBoard />,
    settings: user?.role === 'super_admin' ? <Settings /> : null,
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar activeModule={activeModule} onModuleChange={setActiveModule} />
      <div className="app-wrapper">
        <Topbar activeModule={activeModule} />
        <main className="main-content">
          {moduleMap[activeModule] || <StatusBoard />}
        </main>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <span className="spinner" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppProvider>
          <Toast />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dialed-in" element={<DialedInPage />} />
            <Route path="/dialed-in-pulse" element={<PulsePage />} />
            <Route path="/mobile" element={
              <ProtectedRoute><MobilePage /></ProtectedRoute>
            } />
            <Route path="/*" element={
              <ProtectedRoute><Dashboard /></ProtectedRoute>
            } />
          </Routes>
        </AppProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

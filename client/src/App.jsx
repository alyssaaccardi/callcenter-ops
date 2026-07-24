import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/layout/Sidebar';
import Topbar from './components/layout/Topbar';
import Toast from './components/layout/Toast';
import StatusBoard from './modules/StatusBoard';
import AdminDashboard from './modules/AdminDashboard';
import SmsModule from './modules/SmsModule';
import SlackWorkflows from './modules/SlackWorkflows';
import AgentBoard from './modules/AgentBoard';
import SupportCenter from './modules/SupportCenter';
import AccountReview from './modules/AccountReview';
import TeamLeaderboard from './modules/TeamLeaderboard';
import TechCenter from './modules/TechCenter';
import TechLeaderboard from './modules/TechLeaderboard';
import AppPortal from './modules/AppPortal';
import TechTVPage from './pages/TechTVPage';
import Settings from './modules/Settings';
import StaffBroadcast from './modules/StaffBroadcast';
import UserManagementModule from './modules/UserManagementModule';
import MobilePage from './pages/MobilePage';
import LoginPage from './pages/LoginPage';
import DialedInPage from './pages/DialedInPage';
import SupportTVPage from './pages/SupportTVPage';
import AdminTVPage from './pages/AdminTVPage';
import WhatsNew from './components/WhatsNew';
import ZendeskAuditor from './modules/ZendeskAuditor';
import MitelLeaderboard from './modules/MitelLeaderboard';
import RingLeader from './modules/RingLeader';

function Dashboard() {
  const { user } = useAuth();
  const defaultModule =
    user?.role === 'support'                ? 'support-center'   :
    user?.role === 'tech'                   ? 'tech-center'      :
    user?.role === 'zendesk_auditor'        ? 'zendesk-auditor'  :
    user?.role === 'newsletter_contributor' ? 'ring-leader'      :
    'status';
  return <DashboardInner user={user} defaultModule={defaultModule} />;
}

function DashboardInner({ user, defaultModule }) {
  const [activeModule, setActiveModule] = useState(defaultModule);

  const userRoles  = [user?.role, ...(user?.additionalRoles || [])].filter(Boolean);
  const hasRole    = (...r) => r.some(x => userRoles.includes(x));
  const isOps      = hasRole('super_admin', 'call_center_ops');
  const isSupport  = hasRole('super_admin', 'support');
  const isTech     = hasRole('super_admin', 'tech');
  const isAuditor  = hasRole('super_admin', 'zendesk_auditor');
  const isAnalytics = hasRole('super_admin', 'call_center_ops', 'zendesk_auditor'); // gates the Analytics section (Admin Dashboard + Farewell Reporter — tied together)
  const isNewsletter = hasRole('super_admin', 'newsletter_contributor');

  const moduleMap = {
    'admin-dashboard':  isAnalytics ? <AdminDashboard />        : null,
    status:             isOps     ? <StatusBoard />             : null,
    sms:                isOps     ? <SmsModule />               : null,
    slack:              isOps     ? <SlackWorkflows />           : null,
    monday:             isOps     ? <AgentBoard />              : null,
    'mitel-leaderboard': isOps    ? <MitelLeaderboard />         : null,
    'support-center':   isSupport ? <SupportCenter />           : null,
    'account-review':   isSupport ? <AccountReview />           : null,
    'team-leaderboard': isSupport ? <TeamLeaderboard />         : null,
    'tech-center':      isTech    ? <TechCenter />              : null,
    'tech-leaderboard': isTech    ? <TechLeaderboard />         : null,
    'app-portal':       isTech    ? <AppPortal />               : null,
    'staff-broadcast':  isOps ? <StaffBroadcast /> : null,
    settings:           (user?.role === 'super_admin' || user?.role === 'call_center_ops') ? <Settings /> : null,
    'user-management':  user?.role === 'super_admin' ? <UserManagementModule /> : null,
    'zendesk-auditor':  isAnalytics ? <ZendeskAuditor /> : null,
    'ring-leader':      isNewsletter ? <RingLeader /> : null,
  };

  const fallback = isOps ? <StatusBoard /> : isSupport ? <SupportCenter /> : isTech ? <TechCenter /> : isNewsletter ? <RingLeader /> : <StatusBoard />;

  const isPortal = activeModule === 'app-portal';

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <WhatsNew />
      <Sidebar activeModule={activeModule} onModuleChange={setActiveModule} />
      <div className="app-wrapper">
        {!isPortal && <Topbar />}
        <main className={isPortal ? 'main-content main-content--fullscreen' : 'main-content'}>
          {moduleMap[activeModule] ?? fallback}
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
            <Route path="/login"          element={<LoginPage />} />
            <Route path="/dialed-in"      element={<DialedInPage />} />
            <Route path="/support-dash"   element={<SupportTVPage />} />
            <Route path="/tech-dash"      element={<TechTVPage />} />
            <Route path="/admin-tv"       element={<AdminTVPage />} />
            <Route path="/dialed-in-pulse" element={<Navigate to="/support-dash" replace />} />
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

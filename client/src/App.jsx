import { useState } from 'react';
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
import MinuteAuditor from './modules/MinuteAuditor';
import OverageAlerter from './modules/OverageAlerter';
import SalespersonAuditor from './modules/SalespersonAuditor';
import NoChargeLeaderboard from './modules/NoChargeLeaderboard';
import MitelLeaderboard from './modules/MitelLeaderboard';
import RingLeader from './modules/RingLeader';
import Scriptor from './modules/Scriptor';
import RobStonePage, { RobStoneApp } from './pages/RobStonePage';
import RobAiBoardPage from './pages/RobAiBoardPage';
import BelizeGridWatch from './modules/BelizeGridWatch';
import QaTesting from './modules/QaTesting';
import AiBotQc from './modules/AiBotQc';

// Single source of truth for which "experience" a user gets at the root URL.
// scriptor-only users get the chrome-less Rob-osetta Stone app (no sidebar);
// everyone else gets the full dashboard shell.
function isRobOnly(user) {
  return user?.role === 'scriptor';
}

function Dashboard() {
  const { user } = useAuth();
  if (isRobOnly(user)) return <RobStoneApp />;
  const defaultModule =
    user?.role === 'support'                ? 'support-center'   :
    user?.role === 'tech'                   ? 'tech-center'      :
    user?.role === 'zendesk_auditor'        ? 'zendesk-auditor'  :
    user?.role === 'billing'                ? 'minute-auditor'   :
    user?.role === 'newsletter_contributor' ? 'ring-leader'      :
    user?.role === 'scriptor'               ? 'scriptor'         :
    user?.role === 'rob_ai_board'           ? 'rob-ai-board'     :
    user?.role === 'staffing'               ? 'belize-grid-watch':
    user?.role === 'qa_admin'               ? 'qa-testing':
    user?.role === 'qa_tester'              ? 'qa-testing':
    user?.role === 'qa_leadership'          ? 'qa-testing':
    ['ai_bot_qc', 'ai_bot_qc_admin'].includes(user?.role) ? 'ai-bot-qc':
    'status';
  return <DashboardInner user={user} defaultModule={defaultModule} />;
}

function DashboardInner({ user, defaultModule }) {
  const [activeModule, setActiveModule] = useState(defaultModule);

  const userRoles  = [user?.role, ...(user?.additionalRoles || [])].filter(Boolean);
  const isAiriQaOnly = userRoles.length > 0 && userRoles.every(role => ['ai_bot_qc', 'ai_bot_qc_admin'].includes(role));
  const hasRole    = (...r) => r.some(x => userRoles.includes(x));
  const isOps      = hasRole('super_admin', 'call_center_ops');
  const isSupport  = hasRole('super_admin', 'support');
  const isTech     = hasRole('super_admin', 'tech');
  const isBilling = hasRole('super_admin', 'call_center_ops', 'billing');
  const isAnalytics = hasRole('super_admin', 'call_center_ops', 'zendesk_auditor'); // gates the Analytics section (Admin Dashboard + Farewell Reporter — tied together)
  const isNewsletter = hasRole('super_admin', 'newsletter_contributor');
  const isScribe     = hasRole('super_admin', 'scriptor');
  const isRobAiBoard = hasRole('super_admin', 'rob_ai_board');
  const isStaffing   = hasRole('super_admin', 'staffing');
  const isQa         = hasRole('super_admin', 'qa_admin', 'qa_tester', 'qa_leadership');
  const isAiBotQc    = hasRole('super_admin', 'ai_bot_qc', 'ai_bot_qc_admin');

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
    'minute-auditor':   isBilling ? <MinuteAuditor /> : null,
    'salesperson-auditor': isBilling ? <SalespersonAuditor /> : null,
    'overage-alerter':  isBilling ? <OverageAlerter /> : null,
    'nocharge-leaderboard': isBilling ? <NoChargeLeaderboard /> : null,
    'ring-leader':      isNewsletter ? <RingLeader /> : null,
    scriptor:           isScribe    ? <Scriptor /> : null,
    'rob-ai-board':     isRobAiBoard ? <RobAiBoardPage /> : null,
    'belize-grid-watch': isStaffing  ? <BelizeGridWatch /> : null,
    'qa-testing':        isQa        ? <QaTesting /> : null,
    'ai-bot-qc':         isAiBotQc   ? <AiBotQc /> : null,
  };

  if (!Object.values(moduleMap).some(Boolean)) return <NoDashboardAccess user={user} />;

  const fallback = isOps ? <StatusBoard /> : isSupport ? <SupportCenter /> : isTech ? <TechCenter /> : isNewsletter ? <RingLeader /> : isScribe ? <Scriptor /> : isRobAiBoard ? <RobAiBoardPage /> : isBilling ? <MinuteAuditor /> : isStaffing ? <BelizeGridWatch /> : isQa ? <QaTesting /> : <StatusBoard />;

  const isPortal = activeModule === 'app-portal' || activeModule === 'belize-grid-watch' || activeModule === 'nocharge-leaderboard';

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <WhatsNew />
      {!isAiriQaOnly && <Sidebar activeModule={activeModule} onModuleChange={setActiveModule} />}
      <div className={`app-wrapper${isAiriQaOnly ? ' app-wrapper--focused' : ''}`}>
        {!isPortal && <Topbar hideSystemStatus={isAiriQaOnly} />}
        <main className={isPortal ? 'main-content main-content--fullscreen' : 'main-content'}>
          {moduleMap[activeModule] ?? fallback}
        </main>
      </div>
    </div>
  );
}

function NoDashboardAccess({ user }) {
  return (
    <main className="access-denied-page">
      <section className="access-denied-panel" aria-labelledby="access-denied-title">
        <div className="access-denied-mark" aria-hidden="true">!</div>
        <h1 id="access-denied-title">No dashboard access</h1>
        <p>Your account{user?.email ? <> (<strong>{user.email}</strong>)</> : null} is signed in, but it has not been assigned access to an app.</p>
        <p>Ask your manager or an Ops administrator to grant the correct role. Then sign out and back in.</p>
        <button type="button" onClick={() => { window.location.href = '/auth/logout'; }}>Sign out</button>
      </section>
    </main>
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
            <Route path="/rob"            element={<RobStonePage />} />
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

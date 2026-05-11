import React from 'react';
import UserManagement from '../components/UserManagement';

export default function UserManagementModule() {
  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">User Management</div>
          <div className="page-sub">Manage who has access to this dashboard and their roles</div>
        </div>
      </div>
      <UserManagement />
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import TerminalWindow from './TerminalWindow';

export default function App() {
  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem('pam_user');
    return savedUser ? JSON.parse(savedUser) : null;
  });
  
  const [myRequest, setMyRequest] = useState(() => {
    const savedReq = localStorage.getItem('pam_pending_req');
    return savedReq ? JSON.parse(savedReq) : null;
  });

  const [activeTab, setActiveTab] = useState('servers'); 
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  
  const [usersList, setUsersList] = useState([]);
  const [serversList, setServersList] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [historyList, setHistoryList] = useState([]);
  const [auditList, setAuditList] = useState([]);
  const [activeSessionsList, setActiveSessionsList] = useState([]); // NEW: Active Sessions State
  const [statusMessage, setStatusMessage] = useState('');
  
  const [activeSessionTarget, setActiveSessionTarget] = useState(null);
  const [activeGrantId, setActiveGrantId] = useState(null);

  const [viewingAudit, setViewingAudit] = useState(null);
  const [auditMode, setAuditMode] = useState('commands');
  const [sessionLogs, setSessionLogs] = useState([]);

  // --- VCR PLAYER STATES ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const terminalScrollRef = useRef(null);

  const [newServerName, setNewServerName] = useState('');
  const [newServerIp, setNewServerIp] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('employee');

  const screenFrames = sessionLogs.filter(log => log.action === 'screen_output');

  const generateId = () => {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'sid-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now();
  };

  useEffect(() => {
    if (user && user.role === 'admin') {
      fetchUsers(); fetchServers(); fetchPendingRequests(); fetchAuditHistory(); fetchActiveSessions();
    } else if (user) {
      fetchServers(); fetchEmployeeHistory();
    }
  }, [user]);

  // Real-Time VCR Playback Loop
  useEffect(() => {
    let timer;
    if (isPlaying && screenFrames.length > 0) {
      if (currentFrame >= screenFrames.length) {
        setIsPlaying(false);
        return;
      }

      let delay = 100;
      if (currentFrame < screenFrames.length - 1) {
        const currentLog = screenFrames[currentFrame];
        const nextLog = screenFrames[currentFrame + 1];
        
        if (currentLog?.Timestamp && nextLog?.Timestamp) {
          const t1 = new Date(currentLog.Timestamp).getTime();
          const t2 = new Date(nextLog.Timestamp).getTime();
          delay = Math.min(Math.max(t2 - t1, 10), 2000); 
        }
      }

      timer = setTimeout(() => {
        setCurrentFrame((prev) => prev + 1);
      }, delay);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, currentFrame, screenFrames]);

  useEffect(() => {
    if (terminalScrollRef.current) {
      terminalScrollRef.current.scrollTop = terminalScrollRef.current.scrollHeight;
    }
  }, [currentFrame, screenFrames]);

  const fetchUsers = async () => { const res = await fetch('/admin/users'); if (res.ok) setUsersList(await res.json() || []); };
  const fetchServers = async () => { const res = await fetch('/admin/servers'); if (res.ok) setServersList(await res.json() || []); };
  const fetchPendingRequests = async () => { const res = await fetch('/admin/pending_requests'); if (res.ok) setPendingRequests(await res.json() || []); };
  const fetchActiveSessions = async () => { try { const res = await fetch('/admin/active_sessions'); if (res.ok) setActiveSessionsList(await res.json() || []); } catch (err) { console.error("Failed to fetch active sessions"); } };
  
  const fetchEmployeeHistory = async () => { 
    const res = await fetch(`/employee/history?username=${user.username}`); 
    if (res.ok) { const data = await res.json(); setHistoryList((data || []).reverse()); } 
  };
  const fetchAuditHistory = async () => { 
    const res = await fetch('/admin/audit_history'); 
    if (res.ok) { const data = await res.json(); setAuditList((data || []).reverse()); } 
  };
  
  const fetchAuditLogs = async (grantId, mode) => {
    setViewingAudit(grantId);
    setAuditMode(mode);
    setSessionLogs([]);
    setIsPlaying(false);
    setCurrentFrame(0);
    try {
      const res = await fetch(`http://localhost:9090/audit/logs?grant_id=${grantId}`);
      if (res.ok) {
        const data = await res.json();
        const logs = data || [];
        setSessionLogs(logs);
        const frames = logs.filter(l => l.action === 'screen_output');
        setCurrentFrame(frames.length); 
      }
    } catch (err) { console.error("Failed to fetch audit logs"); }
  };

  // NEW: DELETE AUDIT / RECORDING HANDLER
const handleDeleteAudit = async (grantId) => {
    if (!confirm("Are you sure you want to permanently delete this audit record and its video?")) return;
    try {
        // 1. Delete the JSON video files via the Audit Service (Properly routed to 9090)
        await fetch(`/audit/delete?grant_id=${grantId}`, { method: 'DELETE' });
        
        // 2. Delete the database record via the Policy Engine (Properly routed to 8080)
        await fetch(`/admin/delete_audit_db?grant_id=${grantId}`, { method: 'DELETE' });
        
        // Refresh the UI to show it is gone
        fetchAuditHistory();
    } catch (err) {
        console.error("Failed to delete audit log completely");
    }
};

  const handleTerminateSession = async (grantId) => {
    if (!confirm("Are you sure you want to forcibly terminate this active session?")) return;
    try {
      await fetch(`/admin/terminate_session?grant_id=${grantId}`, { method: 'POST' });
      fetchActiveSessions();
      setStatusMessage(`Session ${grantId} terminated by Admin.`);
    } catch (err) {
      console.error("Failed to terminate session");
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault(); setLoginError('');
    try {
      const res = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (res.ok) {
        const data = await res.json(); setUser(data.user); localStorage.setItem('pam_user', JSON.stringify(data.user));
      } else { setLoginError('Invalid credentials or account frozen.'); }
    } catch (err) { setLoginError('Cannot connect to Policy Engine.'); }
  };

  const handleLogout = () => {
    setUser(null); setMyRequest(null); setActiveSessionTarget(null); setActiveGrantId(null);
    localStorage.removeItem('pam_user'); localStorage.removeItem('pam_pending_req');
  };

  const handleAddServer = async (e) => {
    e.preventDefault();
    await fetch('/admin/add_server', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newServerName, ip_address: newServerIp }) });
    setNewServerName(''); setNewServerIp(''); fetchServers();
  };
  const handleDeleteServer = async (id) => { await fetch(`/admin/delete_server?id=${id}`, { method: 'DELETE' }); fetchServers(); };

  const handleAddUser = async (e) => {
    e.preventDefault();
    await fetch('/admin/add_user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }) });
    setNewUsername(''); setNewPassword(''); fetchUsers();
  };
  const handleDeleteUser = async (id) => { await fetch(`/admin/delete_user?id=${id}`, { method: 'DELETE' }); fetchUsers(); };

  const handleToggleFreeze = async (id) => { await fetch('/admin/freeze_user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); fetchUsers(); };

  const handleApproval = async (grantId, action) => {
    await fetch('/admin/approve_request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_id: grantId, action: action }) });
    fetchPendingRequests(); fetchAuditHistory();
  };

  const requestAccess = async (targetName) => {
    const grantId = generateId();
    // NEW: Enforce 30-minute automatic expiration for all sessions
    const expirationTime = new Date(Date.now() + 30 * 60 * 1000).toISOString(); 
    
    const requestBody = { GrantID: grantId, Username: user.username, Target: targetName, RoleScope: user.role, ExpiresAt: expirationTime };
    
    if (user.role === 'admin') {
      setStatusMessage(`Admin Override: Registering secure session to ${targetName}...`);
      try {
        await fetch('/request_access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
        await fetch('/admin/approve_request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_id: grantId, action: 'approve' }) });
        startGatewaySession({ grantId, Username: user.username, Target: targetName, RoleScope: user.role, ExpiresAt: expirationTime });
        fetchAuditHistory(); fetchActiveSessions();
      } catch (err) { setStatusMessage('Failed to register Admin session.'); }
      return;
    }

    setStatusMessage(`Submitting request for ${targetName}...`);
    try {
      const res = await fetch('/request_access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
      if (res.ok) {
        setStatusMessage('Request submitted! Waiting for Admin approval.');
        const reqData = { grantId, targetName, ...requestBody };
        setMyRequest(reqData); localStorage.setItem('pam_pending_req', JSON.stringify(reqData));
      }
    } catch (error) { setStatusMessage('Failed to submit request.'); }
  };

  const checkMyRequestStatus = async () => {
    if (!myRequest) return;
    try {
      const res = await fetch(`/check_status?grant_id=${myRequest.grantId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.Status === 'approved') {
          setStatusMessage('Request APPROVED! Starting Gateway Session...');
          startGatewaySession(myRequest); localStorage.removeItem('pam_pending_req');
        } else if (data.Status === 'denied') {
          setStatusMessage('Request DENIED by Administrator.');
          setMyRequest(null); localStorage.removeItem('pam_pending_req');
        } else { setStatusMessage('Still pending Admin approval...'); }
      }
    } catch (error) { setStatusMessage('Error checking status.'); }
  };

  const startGatewaySession = async (reqData) => {
    const grantIdToUse = reqData.grantId || reqData.GrantID;
    const grantBody = {
      grant_id: grantIdToUse, user_subject: reqData.Username, target: reqData.Target,
      role_scope: reqData.RoleScope, expires_at: reqData.ExpiresAt, requested_at: new Date().toISOString(),
      device_trust: "trusted", network_cidr: "127.0.0.1/32", ticket_id: "TICKET-999"
    };

    try {
      const response = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(grantBody) });
      const data = await response.json();
      if (response.ok) {
        setStatusMessage(`Session Active: ${data.target}`);
        setActiveSessionTarget(data.target); setActiveGrantId(grantIdToUse); setMyRequest(null);
      } else { setStatusMessage(`Gateway rejected the session.`); }
    } catch (error) { setStatusMessage('Gateway connection failed. Is Rust running?'); }
  };

  const getCleanCommands = () => {
    const rawEvents = sessionLogs.filter(log => log.action === 'keystroke');
    let currentLine = '';
    const commands = [];

    for (let evt of rawEvents) {
      for (let char of evt.data) {
        if (char === '\r' || char === '\n') {
          if (currentLine.trim().length > 0) {
            commands.push(currentLine.trim());
          }
          currentLine = '';
        } else if (char === '\b' || char === '\x7f') {
          currentLine = currentLine.slice(0, -1);
        } else if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          currentLine += char;
        }
      }
    }
    if (currentLine.trim().length > 0) {
      commands.push(currentLine.trim());
    }
    return commands;
  };

  const stripAnsi = (str) => {
    if (!str) return "";
    return str.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\][0-9;]+.*?(?:\x07|\x1B\\))/g, '').replace(/\u0007/g, '');
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-2xl">
          <h1 className="text-2xl font-bold text-white mb-6 text-center">PAM Gateway Login</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-white focus:border-cyan-500 outline-none" placeholder="Username" required />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-white focus:border-cyan-500 outline-none" placeholder="Password" required />
            {loginError && <div className="text-red-400 text-sm text-center font-semibold">{loginError}</div>}
            <button type="submit" className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold py-3 rounded-lg transition-all">Authenticate</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center justify-between shadow-md">
        <div className="font-bold text-xl text-white flex items-center gap-3">
          <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse"></div> Zero-Trust Portal
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-sm font-medium text-slate-300">
            {user.username} <span className={`ml-2 px-2 py-0.5 text-xs font-bold rounded uppercase ${user.role === 'admin' ? 'bg-red-500/20 text-red-400' : 'bg-cyan-500/20 text-cyan-400'}`}>{user.role}</span>
          </div>
          <button onClick={handleLogout} className="px-4 py-1.5 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm border border-slate-700">Logout</button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {activeSessionTarget ? (
          <TerminalWindow 
            targetHost={activeSessionTarget} grantId={activeGrantId} 
            onDisconnect={() => { setActiveSessionTarget(null); setActiveGrantId(null); fetchAuditHistory(); fetchEmployeeHistory(); fetchActiveSessions(); }} 
          />
        ) : (
          <>
            <div className="flex border-b border-slate-800 space-x-6">
              <button onClick={() => setActiveTab('servers')} className={`pb-3 font-semibold ${activeTab === 'servers' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>Authorized Servers</button>
              {user.role === 'employee' && (
                <button onClick={() => setActiveTab('history')} className={`pb-3 font-semibold ${activeTab === 'history' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>My Session History</button>
              )}
              {user.role === 'admin' && (
                <>
                  <button onClick={() => setActiveTab('users')} className={`pb-3 font-semibold ${activeTab === 'users' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>Employees</button>
                  <button onClick={() => setActiveTab('approvals')} className={`pb-3 font-semibold ${activeTab === 'approvals' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>Approvals {pendingRequests.length > 0 && <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full ml-2 animate-bounce">{pendingRequests.length}</span>}</button>
                  {/* NEW: Active Sessions Tab */}
                  <button onClick={() => { setActiveTab('active_sessions'); fetchActiveSessions(); }} className={`pb-3 font-semibold ${activeTab === 'active_sessions' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>Active Sessions</button>
                  <button onClick={() => setActiveTab('audit')} className={`pb-3 font-semibold ${activeTab === 'audit' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>Audit & Replay</button>
                </>
              )}
            </div>

            {/* --- ACTIVE SESSIONS TAB (KILL SWITCH) --- */}
            {activeTab === 'active_sessions' && user.role === 'admin' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-lg font-bold text-white mb-4">Live Active Sessions (Kill Switch)</h2>
                {activeSessionsList.length === 0 ? (
                  <p className="text-slate-500 italic">No active sessions currently running.</p>
                ) : (
                  <div className="space-y-3">
                    {activeSessionsList.map(s => (
                      <div key={s.grant_id} className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex justify-between items-center">
                        <div>
                          <div className="text-white font-bold">
                            User: <span className="text-cyan-400">{s.username}</span> &rarr; Target: <span className="text-emerald-400">{s.target}</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1 font-mono">Grant ID: {s.grant_id} | Expires: {new Date(s.expires_at).toLocaleTimeString()}</div>
                        </div>
                        <button 
                          onClick={() => handleTerminateSession(s.grant_id)} 
                          className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30 px-5 py-2 rounded-lg font-bold text-sm transition-all shadow"
                        >
                          Forcibly Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'servers' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-4">
                  {myRequest && user.role !== 'admin' && (
                    <div className="bg-cyan-950/30 border border-cyan-500/50 rounded-xl p-6 text-center shadow-lg">
                      <h3 className="text-cyan-400 font-bold text-lg mb-2">Session Request Pending</h3>
                      <p className="text-sm text-slate-300 mb-5">Target Host: <span className="font-mono text-white">{myRequest.targetName}</span></p>
                      <button onClick={checkMyRequestStatus} className="bg-cyan-500 text-slate-950 font-bold px-8 py-2.5 rounded-lg hover:bg-cyan-400 transition-colors">Check Authorization Status</button>
                    </div>
                  )}
                  <h2 className="text-lg font-bold text-white">Target Infrastructure</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
                      <h3 className="font-bold text-white mb-1">home-ubuntu</h3>
                      <p className="text-xs text-slate-400 font-mono mb-4">100.80.139.103</p>
                      <button onClick={() => requestAccess('home-ubuntu')} disabled={!!myRequest && user.role !== 'admin'} className="w-full bg-slate-950 text-cyan-400 border border-slate-800 hover:border-cyan-400 font-semibold text-sm py-2 rounded-lg transition-all disabled:opacity-50">Request Connect</button>
                    </div>
                    {serversList.map((srv) => (
                      <div key={srv.ID} className="bg-slate-900 border border-slate-800 rounded-xl p-5 relative hover:border-slate-700 transition-colors">
                        {user.role === 'admin' && ( <button onClick={() => handleDeleteServer(srv.ID)} className="absolute top-4 right-4 text-slate-500 hover:text-red-400 text-xs font-mono">Remove</button> )}
                        <h3 className="font-bold text-white mb-1">{srv.Name}</h3>
                        <p className="text-xs text-slate-400 font-mono mb-4">{srv.IPAddress}</p>
                        <button onClick={() => requestAccess(srv.Name)} disabled={!!myRequest && user.role !== 'admin'} className="w-full bg-slate-950 text-cyan-400 border border-slate-800 hover:border-cyan-400 font-semibold text-sm py-2 rounded-lg transition-all disabled:opacity-50">Request Connect</button>
                      </div>
                    ))}
                  </div>
                </div>
                {user.role === 'admin' && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-fit shadow-lg">
                    <h2 className="text-md font-bold text-white mb-4">Register Target Server</h2>
                    <form onSubmit={handleAddServer} className="space-y-4">
                      <input type="text" placeholder="Server Name" value={newServerName} onChange={e => setNewServerName(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none" required />
                      <input type="text" placeholder="IP Address" value={newServerIp} onChange={e => setNewServerIp(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none" required />
                      <button type="submit" className="w-full bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-950 font-bold text-sm py-2.5 rounded-lg border border-cyan-500/30 transition-all">Add Infrastructure</button>
                    </form>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'approvals' && user.role === 'admin' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-lg font-bold text-white mb-4">Pending Session Requests</h2>
                {pendingRequests.length === 0 ? <p className="text-slate-500 italic">Queue is empty.</p> : (
                  <div className="space-y-3">
                    {pendingRequests.map(req => (
                      <div key={req.ID} className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex justify-between items-center">
                        <div>
                          <div className="text-white font-bold text-lg">{req.Username} <span className="text-slate-400 font-normal text-sm">requests access to</span> <span className="text-cyan-400">{req.Target}</span></div>
                          <div className="text-xs text-slate-500 mt-1 font-mono">Grant ID: {req.GrantID}</div>
                        </div>
                        <div className="space-x-3">
                          <button onClick={() => handleApproval(req.GrantID, 'approve')} className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 border border-emerald-500/30 px-5 py-2 rounded-lg font-bold text-sm transition-all">Approve</button>
                          <button onClick={() => handleApproval(req.GrantID, 'deny')} className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30 px-5 py-2 rounded-lg font-bold text-sm transition-all">Deny</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'history' && user.role === 'employee' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-lg font-bold text-white mb-4">My Past Sessions</h2>
                <div className="space-y-3">
                  {historyList.map(h => (
                    <div key={h.ID} className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-sm text-slate-300">
                      Target: <span className="text-cyan-400">{h.Target}</span> | Status: {h.Status} | Grant ID: {h.GrantID}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'users' && user.role === 'admin' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
                  <h2 className="text-md font-bold text-white mb-4">Employee Management</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                      <thead className="bg-slate-950 text-slate-400 font-mono text-xs uppercase">
                        <tr><th className="p-4">Username</th><th className="p-4">Status</th><th className="p-4 text-right">Actions</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50">
                        {usersList.map((u) => (
                          <tr key={u.id} className="hover:bg-slate-800/30">
                            <td className="p-4 font-semibold text-white">{u.username}</td>
                            <td className="p-4">
                              <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${u.is_frozen ? 'bg-orange-500/10 text-orange-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                {u.is_frozen ? 'Frozen' : 'Active'}
                              </span>
                            </td>
                            <td className="p-4 text-right space-x-3">
                              {u.username !== 'admin' && (
                                <>
                                  <button onClick={() => handleToggleFreeze(u.id)} className="text-orange-400 hover:text-orange-300 font-mono text-xs">{u.is_frozen ? 'Unfreeze' : 'Freeze'}</button>
                                  <button onClick={() => handleDeleteUser(u.id)} className="text-red-400 hover:text-red-300 font-mono text-xs">Remove</button>
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-fit shadow-lg">
                  <h2 className="text-md font-bold text-white mb-4">Register Employee</h2>
                  <form onSubmit={handleAddUser} className="space-y-4">
                    <input type="text" placeholder="Username" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none" required />
                    <input type="password" placeholder="Password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none" required />
                    <select value={newRole} onChange={e => setNewRole(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none">
                      <option value="employee">Standard Employee</option>
                      <option value="admin">Administrator</option>
                    </select>
                    <button type="submit" className="w-full bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold text-sm py-2.5 rounded-lg border border-emerald-500/30 transition-all">Create Account</button>
                  </form>
                </div>
              </div>
            )}

            {activeTab === 'audit' && user.role === 'admin' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-lg font-bold text-white mb-4">Session Evidence Plane</h2>
                <div className="space-y-4">
                  {auditList.map(a => (
                    <div key={a.ID} className="bg-slate-950 border border-slate-800 rounded-lg p-5">
                      <div className="flex justify-between items-center mb-3">
                        <div className="text-white font-bold">
                          User: <span className="text-cyan-400">{a.Username}</span> &rarr; Target: <span className="text-emerald-400">{a.Target}</span>
                        </div>
                        <div className="space-x-3">
                          <button onClick={() => fetchAuditLogs(a.GrantID, 'commands')} className="bg-slate-800 text-slate-300 hover:text-white px-4 py-1.5 rounded text-xs font-bold border border-slate-700">
                            View Commands
                          </button>
                          <button onClick={() => fetchAuditLogs(a.GrantID, 'video')} className="bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500 hover:text-slate-950 px-4 py-1.5 rounded text-xs font-bold border border-cyan-500/30 transition-colors">
                            ▶ Play Video Replay
                          </button>
                          <button onClick={() => handleDeleteAudit(a.GrantID)} className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white px-4 py-1.5 rounded text-xs font-bold border border-red-500/30 transition-colors">
                            Delete Audit
                          </button>
                        </div>
                      </div>
                      <div className="text-xs font-mono text-slate-500">Session ID: {a.GrantID}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* --- VCR PLAYER MODAL OVERLAY --- */}
      {viewingAudit && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
              <h2 className="text-lg font-bold text-white flex items-center gap-3">
                <span className={`w-3 h-3 rounded-full ${isPlaying ? 'bg-emerald-400 animate-ping' : 'bg-red-500'}`}></span>
                {auditMode === 'commands' ? 'Command History' : 'VCR Visual Session Replay'} 
                <span className="text-slate-500 font-mono text-sm ml-2">({viewingAudit})</span>
              </h2>
              <button onClick={() => { setViewingAudit(null); setIsPlaying(false); }} className="text-slate-400 hover:text-red-400 font-bold text-xl">&times;</button>
            </div>
            
            <div className="p-6 bg-[#0f172a] flex flex-col space-y-4">
              {auditMode === 'commands' ? (
                <div className="h-[450px] overflow-y-auto font-mono text-sm space-y-2 bg-slate-950 p-4 rounded-lg border border-slate-800">
                  {getCleanCommands().length === 0 ? (
                    <div className="text-slate-500 italic text-center mt-20">No commands were executed.</div>
                  ) : (
                    getCleanCommands().map((cmd, i) => (
                      <div key={i} className="text-emerald-400 flex items-start gap-3">
                        <span className="text-slate-500 select-none">[{i + 1}]</span>
                        <span className="text-cyan-500 select-none">$&gt;</span>
                        <span className="break-all">{cmd}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div 
                    ref={terminalScrollRef}
                    className="bg-slate-950 border border-slate-800 rounded-lg p-4 h-[370px] font-mono text-xs text-emerald-400 overflow-y-auto relative shadow-inner"
                  >
                    <pre className="whitespace-pre-wrap break-words p-2">
                      {screenFrames.length === 0 ? "Loading frames..." : stripAnsi(screenFrames.slice(0, currentFrame).map(l => l.data).join(''))}
                    </pre>
                  </div>
                  
                  <div className="bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 flex items-center justify-between text-slate-300">
                    <div className="flex items-center space-x-3">
                      <button 
                        onClick={() => {
                          if (currentFrame >= screenFrames.length) setCurrentFrame(0);
                          setIsPlaying(!isPlaying);
                        }} 
                        className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold px-4 py-1.5 rounded text-xs transition-colors flex items-center gap-1.5 shadow"
                      >
                        {isPlaying ? '⏸ Pause' : '▶ Play Recording'}
                      </button>
                      <button 
                        onClick={() => { setIsPlaying(false); setCurrentFrame(0); }} 
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded text-xs transition-colors border border-slate-700"
                      >
                        ⏮ Restart
                      </button>
                    </div>

                    <div className="flex items-center space-x-3 flex-1 mx-6">
                      <span className="text-[10px] font-mono text-slate-400">{currentFrame} / {screenFrames.length}</span>
                      <input 
                        type="range" 
                        min="0" 
                        max={screenFrames.length} 
                        value={currentFrame} 
                        onChange={(e) => { setIsPlaying(false); setCurrentFrame(Number(e.target.value)); }}
                        className="w-full accent-cyan-500 cursor-pointer h-1 bg-slate-800 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
/* Prostarm access directory -------------------------------------------------
   This is the only client-side mapping boundary.  In production the same
   operations belong behind authenticated APIs; the UI must never be the
   enforcement point.  The Excel/Flow endpoint remains a directory source for
   this prototype so the existing theme and hosting model remain unchanged.

   Supported directory columns (case-insensitive):
   EmpCode, Username/Login/Email, FullName, Branch/Branches/BranchCode,
   Role/Roles/Access Level, ManagerCode, RegionalManagerCode, Designation,
   IsAdmin/IsHOAdmin, IsFinalApprover, Zone/Region and BranchName.
*/
(function (global) {
  'use strict';

  const ROLE_ORDER = ['admin', 'auditor', 'final_approver', 'regional', 'branch'];
  const ROLE_TITLES = { admin: 'HO Admin', auditor: 'Finance Auditor', final_approver: 'Final Approver', regional: 'Regional Manager', branch: 'Branch User' };
  const PERMISSIONS = {
    admin: ['*'], auditor: ['analytics.view', 'ledger.view', 'expense.audit'],
    final_approver: ['ledger.view', 'approval.view', 'approval.final'],
    regional: ['ledger.view', 'analytics.view', 'approval.view', 'approval.recommend'],
    branch: ['ledger.view', 'expense.create', 'expense.upload', 'approval.request']
  };
  const state = { endpoint: '', users: new Map(), aliases: new Map(), branches: new Map(), loaded: false, loading: null };
  const text = value => value == null ? '' : String(value).trim();
  const key = value => text(value).toUpperCase();
  const headerKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const get = (row, ...names) => {
    // Excel/Power Automate headers often contain a trailing space, underscore,
    // or a display-space. Match headers semantically rather than exactly.
    const found = Object.keys(row || {}).find(k => names.some(n => headerKey(k) === headerKey(n)));
    return found === undefined ? undefined : row[found];
  };
  const split = value => String(value || '').split(/[;,|]/).map(text).filter(Boolean);
  function branchCode(value) { return text(value).replace(/\s*-\s*/g, '_'); }
  function rolesFor(row) {
    // Some existing directory rows use Designation instead of Role.  Include
    // it as a compatibility source, while explicit Roles remain preferred.
    const raw = [get(row, 'Roles', 'Role', 'User Role', 'UserRole', 'Role Name', 'RoleName', 'Access Level', 'AccessLevel', 'User Type', 'UserType'), get(row, 'Designation')]
      .map(value => split(value).join(' ')).join(' ').toLowerCase();
    const roles = new Set();
    if (/admin/.test(raw) || ['true', 'yes', '1'].includes(String(get(row, 'IsAdmin', 'IsHOAdmin') || '').toLowerCase())) roles.add('admin');
    if (/audit/.test(raw)) roles.add('auditor');
    if (/regional|\brm\b/.test(raw)) roles.add('regional');
    if (/final approv/.test(raw) || ['true', 'yes', '1'].includes(String(get(row, 'IsFinalApprover') || '').toLowerCase()) || /final approving authority/.test(String(get(row, 'Designation') || '').toLowerCase())) roles.add('final_approver');
    if (!roles.size) roles.add('branch');
    return ROLE_ORDER.filter(r => roles.has(r));
  }
  function rebuild(rows) {
    state.users.clear(); state.aliases.clear(); state.branches.clear();
    rows.forEach(row => {
      const id = key(get(row, 'EmpCode', 'EmployeeCode', 'UserId', 'Username'));
      if (!id) return;
      // Prefer the explicit multi-value column.  `get(... 'Branches','Branch')`
      // is unsafe when both columns exist because Excel property order may
      // select the single Branch column first.
      const branchValue = get(row, 'Branches') || get(row, 'Branch', 'BranchCode');
      const branches = [...new Set(split(branchValue).map(branchCode).filter(Boolean))];
      const user = { id, name: text(get(row, 'FullName', 'DisplayName', 'Name')) || id, email: text(get(row, 'Email', 'EmailAddress', 'Email ID')),
        roles: rolesFor(row), branches, managerId: key(get(row, 'ManagerCode', 'ReportsTo', 'ManagerId')) || null,
        regionalManagerId: key(get(row, 'RegionalManagerCode', 'RegionalManagerId')) || null,
        designation: text(get(row, 'Designation')), zone: text(get(row, 'Zone', 'Region')) };
      state.users.set(id, user);
      [id, get(row, 'Username', 'Login', 'UserName'), user.email].filter(Boolean).forEach(a => state.aliases.set(key(a), id));
      branches.forEach(code => {
        const old = state.branches.get(code) || { code, name: text(get(row, 'BranchName')) || code.split('_').slice(1).join(' ') || code, zone: user.zone, regionalManagerId: user.regionalManagerId, members: [] };
        if (!old.zone && user.zone) old.zone = user.zone;
        if (!old.regionalManagerId && user.regionalManagerId) old.regionalManagerId = user.regionalManagerId;
        old.members.push(id); state.branches.set(code, old);
      });
    });
    // Manager references can be EmpCodes, usernames, or emails.  Resolve them
    // only after every alias has been registered, rather than assuming the
    // manager row appears before the employee row in Excel.
    state.users.forEach(user => {
      user.managerId = state.aliases.get(key(user.managerId)) || user.managerId;
      user.regionalManagerId = state.aliases.get(key(user.regionalManagerId)) || user.regionalManagerId;
    });
    state.branches.forEach(branch => {
      branch.regionalManagerId = state.aliases.get(key(branch.regionalManagerId)) || branch.regionalManagerId;
    });
    state.loaded = true;
  }
  /* --- session cache ------------------------------------------------
     The directory is the same for every page in the suite, but each page
     was re-fetching it from Power Automate on load. A cold Flow can take
     several seconds, so the ledger, requisition and analytics pages each
     paid that cost again. Rows are cached for the browser session and
     revalidated in the background, so only the first page waits.
  ------------------------------------------------------------------- */
  const CACHE_KEY = 'prostarm:directory:v1';
  const CACHE_TTL_MS = 30 * 60 * 1000;

  function readCache() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) return null;
      if (Date.now() - (raw.at || 0) > CACHE_TTL_MS) return null;
      return raw.rows;
    } catch (e) { return null; }
  }
  function writeCache(rows) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows: rows })); }
    catch (e) { /* quota — the network path still works */ }
  }
  function fetchRows() {
    return fetch(state.endpoint, { credentials: 'omit' })
      .then(r => { if (!r.ok) throw new Error('Directory service returned HTTP ' + r.status); return r.json(); })
      .then(payload => {
        const rows = Array.isArray(payload) ? payload : (payload.value || payload.rows || []);
        if (!Array.isArray(rows) || !rows.length) throw new Error('Directory service returned no users.');
        return rows;
      });
  }

  async function loadDirectory(endpoint) {
    if (endpoint) state.endpoint = endpoint;
    if (state.loaded) return api.snapshot();
    if (state.loading) return state.loading;

    const cached = readCache();
    if (cached) {
      rebuild(cached);
      /* Revalidate quietly so an Excel change lands on the next page view. */
      fetchRows().then(rows => { rebuild(rows); writeCache(rows); }).catch(() => {});
      return api.snapshot();
    }

    state.loading = fetchRows()
      .then(rows => { rebuild(rows); writeCache(rows); return api.snapshot(); })
      .finally(() => { state.loading = null; });
    return state.loading;
  }
  function userFor(identity) { return state.users.get(state.aliases.get(key(identity)) || key(identity)) || null; }
  function allBranches() { return [...state.branches.keys()]; }
  function primaryRole(roles) { return ROLE_ORDER.find(role => roles.includes(role)) || 'branch'; }
  function permissions(roles) { return [...new Set(roles.flatMap(role => PERMISSIONS[role] || []))]; }
  function can(session, permission) { return !!session && (session.permissions || []).some(p => p === '*' || p === permission); }
  function branchScope(user) {
    if (user.roles.includes('admin') || user.roles.includes('auditor')) return allBranches();
    if (user.roles.includes('regional')) {
      // 1. Explicit RegionalManagerCode against the branch — strongest signal.
      let scoped = allBranches().filter(code => (state.branches.get(code) || {}).regionalManagerId === user.id);
      if (scoped.length) return dedupe(scoped.concat(user.branches));

      // 2. Otherwise infer the region from who reports to this manager.
      //    Most directories carry ManagerCode but no RegionalManagerCode,
      //    which left a Regional Manager scoped to their own single branch.
      const reports = [...state.users.values()].filter(u => u.managerId === user.id || u.regionalManagerId === user.id);
      scoped = dedupe(reports.flatMap(u => u.branches).concat(user.branches));
      if (scoped.length > 1) return scoped;

      // 3. Failing that, fall back to every branch sharing their Zone.
      if (user.zone) {
        const z = key(user.zone);
        const byZone = allBranches().filter(code => key((state.branches.get(code) || {}).zone) === z);
        if (byZone.length) return dedupe(byZone.concat(user.branches));
      }
      return scoped.length ? scoped : user.branches;
    }
    return user.branches;
  }
  function dedupe(list) { return [...new Set(list.filter(Boolean))]; }
  function approvalRoute(requesterId, branch) {
    const requester = userFor(requesterId); if (!requester) return [];
    const route = [], seen = new Set([requester.id]);
    let next = requester.managerId || (state.branches.get(branch || requester.branches[0]) || {}).regionalManagerId;
    while (next && !seen.has(next)) { seen.add(next); const u = userFor(next); if (!u) break; route.push(u.id); next = u.managerId; }
    const finalApprovers = [...state.users.values()].filter(u => u.roles.includes('final_approver')).map(u => u.id);
    if (finalApprovers.length) finalApprovers.forEach(id => { if (!seen.has(id)) route.push(id); });
    return route;
  }
  function createSession(auth, suppliedUsername) {
    // Use the name entered on the login screen before a generic auth-service
    // username. An EmpCode returned by the service remains the strongest key.
    const candidates = [auth && (auth.empCode || auth.EmpCode), suppliedUsername,
      auth && (auth.username || auth.userId || auth.email)].filter(Boolean);
    const user = candidates.map(userFor).find(Boolean);
    if (!user) throw new Error('Your login is valid, but you are not mapped in the access directory. Contact Head Office.');
    const branches = branchScope(user);
    if (!branches.length && !user.roles.includes('final_approver')) throw new Error('No branches are mapped to your login. Contact Head Office.');
    const roles = user.roles.slice();
    return { subjectId: user.id, username: user.id, name: user.name, email: user.email, roles, role: primaryRole(roles), branches, branch: branches[0] || 'ALL', permissions: permissions(roles), directoryVersion: 1 };
  }
  function refreshSession(session) {
    if (!session) return null;
    const user = userFor(session.subjectId || session.username);
    if (!user) return null;
    const refreshed = createSession({ empCode: user.id }, user.id);
    return Object.assign({}, session, refreshed, { loginAt: session.loginAt, token: session.token || '' });
  }
  const api = {
    configure: endpoint => { state.endpoint = endpoint; }, loadDirectory, userFor, can, roleTitle: role => ROLE_TITLES[role] || role,
    createSession, refreshSession, allowedBranches: session => { const u = session && userFor(session.subjectId || session.username); return u ? branchScope(u) : ((session && Array.isArray(session.branches)) ? session.branches.slice() : []); },
    approvalRoute, approvers: (requester, branch) => approvalRoute(requester, branch).map(id => userFor(id)).filter(Boolean),
    snapshot: () => ({ users: [...state.users.values()], branches: [...state.branches.values()] }),
    clearCache: () => { try { sessionStorage.removeItem(CACHE_KEY); } catch (e) {} state.loaded = false; },
    /* Raw directory rows, served from the session cache when available so a
       page does not have to hit Power Automate a second time for the same
       data it already holds. */
    rows: async () => { const c = readCache(); if (c) return c; const rows = await fetchRows(); writeCache(rows); return rows; }
  };
  global.ProstarmRBAC = api;
})(window);

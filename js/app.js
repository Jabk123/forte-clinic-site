/* =========================================================
   Forte Community Clinic — Information System (Frontend)
   =========================================================

   PRODUCTION SETUP
   ----------------
   1. This frontend talks to a backend API over HTTP.
   2. Set the API base URL below (or via window.FORTE_API_BASE).
   3. The Microsoft SQL Server connection string belongs ONLY
      on the server (backend). Never put it in browser code.

   See README.md and backend/ for the full connection-string
   examples (Node/Express and ASP.NET) and deployment steps.

   ========================================================= */

/** API base URL — change this after you deploy the backend */
const API_BASE = (typeof window !== 'undefined' && window.FORTE_API_BASE)
  ? window.FORTE_API_BASE.replace(/\/$/, '')
  : 'http://localhost:3000/api';

const SESSION_KEY = 'forte_clinic_session';

const ROLE_LABELS = {
  Patient: 'Patient',
  Doctor: 'Doctor',
  Nurse: 'Nurse',
  Pharmacist: 'Pharmacist',
  Receptionist: 'Receptionist',
  Manager: 'Manager',
  Admin: 'Admin'
};

const ROLE_HOME = {
  Patient: 'patient-dashboard.html',
  Doctor: 'doctor-dashboard.html',
  Nurse: 'doctor-dashboard.html',
  Pharmacist: 'pharmacist-dashboard.html',
  Receptionist: 'receptionist-dashboard.html',
  Manager: 'manager-dashboard.html',
  Admin: 'admin-dashboard.html'
};

/* ---------- Session (client-side token / user info only) ---------- */
const Session = {
  get() {
    const r = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    return r ? JSON.parse(r) : null;
  },
  set(user, userType, remember) {
    const payload = JSON.stringify({
      UserType: userType,
      User_ID: userType === 'Patient' ? user.Patient_ID : user.Employee_ID,
      Role: userType === 'Patient' ? 'Patient' : user.EmployeeType,
      FirstName: user.FirstName,
      LastName: user.LastName,
      Email: user.Email,
      Token: user.Token || null
    });
    if (remember) {
      localStorage.setItem(SESSION_KEY, payload);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, payload);
      localStorage.removeItem(SESSION_KEY);
    }
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  },
  requireLogin(allowedRoles) {
    const s = this.get();
    if (!s) {
      window.location.href = 'login.html';
      return null;
    }
    if (allowedRoles && !allowedRoles.includes(s.Role)) {
      window.location.href = ROLE_HOME[s.Role] || 'index.html';
      return null;
    }
    return s;
  }
};

/* ---------- API client ---------- */
const API = {
  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const session = Session.get();
    if (session && session.Token) {
      headers['Authorization'] = 'Bearer ' + session.Token;
    }
    const opts = { method, headers, cache: 'no-store' };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(API_BASE + path, opts);
    } catch (err) {
      const error = new Error(
        'Unable to reach the server. Check that the backend is running and API_BASE is correct.'
      );
      error.code = 'NETWORK';
      throw error;
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    if (!res.ok) {
      const msg = (data && data.message) || res.statusText || 'Request failed';
      const error = new Error(msg);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  delete(path) { return this.request('DELETE', path); }
};

/* Convenience wrappers used by pages (same shape as old DB calls where possible) */
const DB = {
  // Auth
  async login(email, password) {
    return API.post('/auth/login', { email, password });
  },
  async registerPatient(payload) {
    return API.post('/patients/register', payload);
  },
  async registerEmployee(payload) {
    return API.post('/employees', payload);
  },

  // Patients
  async getPatients() { return API.get('/patients'); },
  async getPatient(id) { return API.get('/patients/' + id); },
  async updatePatient(id, payload) { return API.put('/patients/' + id, payload); },

  // Employees / accounts
  async getEmployees() { return API.get('/employees'); },
  async setAccountActive(type, id, isActive) {
    return API.patch(`/${type.toLowerCase()}s/${id}/active`, { isActive });
  },

  // Appointments
  async getAppointments(params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return API.get('/appointments' + q);
  },
  async createAppointment(payload) { return API.post('/appointments', payload); },
  async cancelAppointment(id) { return API.patch('/appointments/' + id + '/cancel'); },

  // Consultations
  async getConsultations(params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return API.get('/consultations' + q);
  },
  async createConsultation(payload) { return API.post('/consultations', payload); },
  async getDiagnoses() { return API.get('/diagnoses'); },

  // Pharmacy / Inventory
  async getInventory() { return API.get('/inventory'); },
  async updateInventoryItem(id, payload) { return API.put('/inventory/' + id, payload); },
  async dispense(prescriptionId) { return API.post('/prescriptions/' + prescriptionId + '/dispense'); },

  // Payments
  async getPayments(params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return API.get('/payments' + q);
  },
  async createPayment(payload) { return API.post('/payments', payload); },
  async confirmPayment(id) { return API.patch('/payments/' + id + '/confirm'); },

  // Reports & metrics
  async getReports(type) { return API.get('/reports/' + (type || 'summary')); },
  async getMetrics() { return API.get('/metrics'); },

  // Audit (optional – backend may log automatically)
  async logAudit() { /* no-op on frontend; backend handles audit */ }
};

/* ---------- UI helpers ---------- */
function toast(msg, type) {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast-msg ' + (type || '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function showBanner(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'banner show ' + (type || 'info');
}

function formatCurrency(n) {
  return 'R ' + Number(n || 0).toFixed(2);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (String(iso).length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusBadge(status) {
  const map = {
    Scheduled: 'badge-teal',
    Completed: 'badge-green',
    Cancelled: 'badge-coral',
    'No-show': 'badge-amber',
    Yes: 'badge-green',
    No: 'badge-amber',
    Mild: 'badge-teal',
    Moderate: 'badge-amber',
    Severe: 'badge-coral',
    'Low stock': 'badge-coral',
    Expiring: 'badge-amber',
    Expired: 'badge-coral'
  };
  return `<span class="badge ${map[status] || 'badge-teal'}">${status}</span>`;
}

function emptyState(message, actionHtml = '') {
  return `<div class="empty-state">
    <div class="empty-icon" aria-hidden="true">○</div>
    <p>${message}</p>
    ${actionHtml}
  </div>`;
}

function apiErrorMessage(err) {
  if (err && err.code === 'NETWORK') {
    return 'Server is offline or unreachable. Please ensure the backend API is running.';
  }
  return (err && err.message) || 'Something went wrong. Please try again.';
}

const Validate = {
  email(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()); },
  phone(v) { return /^0\d{9}$/.test(String(v).replace(/\s/g, '')); },
  notEmpty(v) { return v !== undefined && v !== null && String(v).trim().length > 0; },
  minLen(v, n) { return String(v || '').trim().length >= n; },
  password(v) { return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(v); },
  isFutureOrTodayDate(v) {
    if (!v) return false;
    const d = new Date(v + 'T00:00:00');
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return d >= t;
  },
  decimal(v) { return /^\d+(\.\d{1,2})?$/.test(String(v).trim()); },
  integer(v) { return /^\d+$/.test(String(v).trim()); },
  positiveInt(v) { return /^\d+$/.test(String(v).trim()) && parseInt(v, 10) > 0; }
};

function bindField(inputEl, errorEl, testFn, message) {
  function run() {
    const ok = testFn(inputEl.value);
    inputEl.classList.toggle('invalid', !ok);
    inputEl.classList.toggle('valid', ok && inputEl.value.trim().length > 0);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.toggle('show', !ok);
    }
    return ok;
  }
  inputEl.addEventListener('blur', run);
  inputEl.addEventListener('input', () => {
    if (inputEl.classList.contains('invalid')) run();
  });
  return run;
}

/* Simple SVG icons used in nav */
const ICONS = {
  dashboard: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  appointment: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  patient: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  consult: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
  pharmacy: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6v4H9zM10 7v13a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V7"/><path d="M6 11h12"/></svg>',
  payment: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  report: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>',
  metrics: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  users: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  employee: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  dispense: '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2v6M14 2v6M4 10h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10z"/></svg>'
};

const DASH_LINKS = {
  Patient: [
    { href: 'patient-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'appointment.html', label: 'Book Appointment', icon: ICONS.appointment }
  ],
  Doctor: [
    { href: 'doctor-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'consultation.html', label: 'Record Consultation', icon: ICONS.consult }
  ],
  Nurse: [
    { href: 'doctor-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'consultation.html', label: 'Record Consultation', icon: ICONS.consult }
  ],
  Pharmacist: [
    { href: 'pharmacist-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'pharmacy.html', label: 'Manage Inventory', icon: ICONS.pharmacy },
    { href: 'dispense.html', label: 'Dispense Medication', icon: ICONS.dispense }
  ],
  Receptionist: [
    { href: 'receptionist-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'patient-details.html', label: 'Manage Patient Details', icon: ICONS.patient },
    { href: 'appointment.html', label: 'Book Appointment', icon: ICONS.appointment },
    { href: 'payment.html', label: 'Payment', icon: ICONS.payment }
  ],
  Manager: [
    { href: 'manager-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'reports.html', label: 'Generate Reports', icon: ICONS.report }
  ],
  Admin: [
    { href: 'admin-dashboard.html', label: 'Dashboard', icon: ICONS.dashboard },
    { href: 'register-employee.html', label: 'Register Employee', icon: ICONS.employee },
    { href: 'manage-accounts.html', label: 'Manage Accounts', icon: ICONS.users },
    { href: 'metrics.html', label: 'System Metrics', icon: ICONS.metrics }
  ]
};

function renderChrome(activeHref) {
  const s = Session.get();
  const header = document.getElementById('app-header');
  if (header) {
    header.innerHTML = `
      <div class="vitals-strip" aria-hidden="true"></div>
      <div class="topbar">
        <a class="brand" href="${s ? ROLE_HOME[s.Role] : 'index.html'}">
          <span class="brand-mark" aria-hidden="true"></span>
          <span>
            <div class="brand-name">Forte Community Clinic</div>
            <div class="brand-sub">CLINIC INFORMATION SYSTEM</div>
          </span>
        </a>
        <div class="topbar-actions">
          ${s ? `
            <span class="user-chip">
              <span class="user-name">${s.FirstName} ${s.LastName}</span>
              <span class="role-pill">${ROLE_LABELS[s.Role] || s.Role}</span>
            </span>
            <button type="button" class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>
          ` : `
            <a class="btn btn-ghost btn-sm" href="login.html">Sign in</a>
            <a class="btn btn-primary btn-sm" href="register.html">Register</a>
          `}
        </div>
      </div>`;
    const lb = document.getElementById('logout-btn');
    if (lb) {
      lb.addEventListener('click', () => {
        Session.clear();
        window.location.href = 'login.html';
      });
    }
  }

  const dashNav = document.getElementById('dash-nav');
  if (dashNav && s) {
    const links = DASH_LINKS[s.Role] || [];
    dashNav.innerHTML = links.map(l =>
      `<a href="${l.href}" class="${activeHref === l.href ? 'active' : ''}">${l.icon || ''}${l.label}</a>`
    ).join('');
  }

  renderHelp();
  renderFooter();
}

function renderHelp() {
  if (document.getElementById('help-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'help-btn';
  btn.setAttribute('aria-label', 'Open help');
  btn.textContent = '?';
  const panel = document.createElement('div');
  panel.id = 'help-panel';
  const tips = (window.PAGE_HELP && window.PAGE_HELP.length)
    ? window.PAGE_HELP
    : [
        'Fields marked with a red asterisk are required.',
        'Validation feedback appears when you leave a field.',
        'Use the sidebar to open screens for your role.'
      ];
  panel.innerHTML = `<h4>Need a hand?</h4><ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`;
  document.body.appendChild(btn);
  document.body.appendChild(panel);
  btn.addEventListener('click', () => panel.classList.toggle('show'));
}

function renderFooter() {
  if (document.getElementById('app-footer')) return;
  const footer = document.createElement('footer');
  footer.id = 'app-footer';
  footer.innerHTML = `
    <div class="footer-inner">
      <span>Forte Community Clinic · Information System</span>
      <span class="footer-links">
        <a href="index.html">Home</a>
        <a href="login.html">Sign in</a>
      </span>
    </div>`;
  document.body.appendChild(footer);
}


/* ---------- Compatibility for pages not yet fully migrated ----------
   Old pages may still call DB.load() / DB.save(). Those methods no longer
   exist as localStorage. We provide stubs that surface a clear error.
   Prefer the async DB.* API methods above. */
DB.load = function () {
  throw new Error('This screen still needs to be connected to the live API. See README.md — the local demo store has been removed.');
};
DB.save = function () {
  throw new Error('This screen still needs to be connected to the live API. See README.md.');
};
DB.reset = function () {};
function nextId() { return Date.now(); }
function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function nowISO() { return new Date().toISOString(); }

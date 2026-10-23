// server.js — الخادم الرئيسي لنظام الحضور والانصراف
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { db, sessionSecret } = require('./lib/db');
const { TZ, localDate, localTime, isDate, isTime, addDays, localToUtcIso } = require('./lib/time');
const { getMovements, dailySummary } = require('./lib/report');
const { buildXlsx, readXlsx } = require('./lib/xlsx');
const { toCsv, parseCsv } = require('./lib/csv');

const PORT = process.env.PORT || 3000;
const SECRET = sessionSecret();
const OPEN_SHIFT_HOURS = 16; // بعدها يُعتبر الدخول المفتوح منتهيًا (نسي تسجيل الانصراف)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-pin', 10);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '200kb' }));

/* ============ أدوات مساعدة ============ */
const fail = (res, status, code, extra = {}) => res.status(status).json({ ok: false, error: code, ...extra });
const validPin = (p) => typeof p === 'string' && /^\d{4,6}$/.test(p);
const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);

// تحديد عدد المحاولات الخاطئة (حماية من التخمين)
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}
function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= 5) { a.lockedUntil = Date.now() + 5 * 60 * 1000; a.count = 0; }
  attempts.set(key, a);
}
const clearFailures = (key) => attempts.delete(key);
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (!a.lockedUntil || a.lockedUntil < now) attempts.delete(k);
}, 10 * 60 * 1000).unref();

/* ============ جلسات الموارد البشرية ============ */
const COOKIE = 'hr_session';
const SESSION_HOURS = 12;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setSessionCookie(req, res, value, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function requireHR(req, res, next) {
  const s = verify(getCookie(req, COOKIE));
  if (!s) return fail(res, 401, 'unauthorized');
  const user = db.prepare('SELECT id, username, must_change FROM hr_users WHERE id = ?').get(s.uid);
  if (!user) return fail(res, 401, 'unauthorized');
  req.hr = user;
  next();
}

// إنشاء حساب المدير الأول عند أول تشغيل
(function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM hr_users').get().c;
  if (count > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin1234';
  db.prepare('INSERT INTO hr_users(username, password_hash, must_change) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), process.env.ADMIN_PASSWORD ? 0 : 1);
  console.log(`[setup] HR admin created: ${username}${process.env.ADMIN_PASSWORD ? '' : ' / admin1234 (change it after login)'}`);
})();

/* ============ البث اللحظي (Server-Sent Events) ============ */
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

/* ============ عام ============ */
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/time', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), tz: TZ, date: localDate(), time: localTime() });
});

/* ============ تسجيل الحضور والانصراف (الموظف) ============ */
const findEmployee = db.prepare('SELECT * FROM employees WHERE emp_no = ?');
const lastPunch = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY ts DESC, id DESC LIMIT 1');
const insertPunch = db.prepare(
  'INSERT INTO attendance(employee_id, type, ts, work_date, source, ip, note) VALUES (?,?,?,?,?,?,?)');

function isOpen(last, now = Date.now()) {
  return !!last && last.type === 'in' && now - new Date(last.ts).getTime() < OPEN_SHIFT_HOURS * 3600 * 1000;
}

app.post('/api/punch', async (req, res) => {
  const empNo = clean(req.body?.emp_no, 30);
  const pin = clean(req.body?.pin, 10);
  const action = req.body?.action;
  if (!empNo || !pin) return fail(res, 400, 'missing_fields');
  if (!['in', 'out'].includes(action)) return fail(res, 400, 'invalid_action');

  const key = `emp:${req.ip}:${empNo}`;
  const wait = tooManyAttempts(key);
  if (wait) return fail(res, 429, 'too_many_attempts', { retry_after: wait });

  const emp = findEmployee.get(empNo);
  // نقارن دائمًا (حتى لو لم يوجد الموظف) حتى لا يُكشف وجود الرقم من زمن الاستجابة
  const okPin = await bcrypt.compare(pin, emp ? emp.pin_hash : DUMMY_HASH);
  if (!emp || !okPin) { recordFailure(key); return fail(res, 401, 'invalid_credentials'); }
  if (!emp.active) return fail(res, 403, 'inactive');
  clearFailures(key);

  const now = new Date();
  const last = lastPunch.get(emp.id);
  const open = isOpen(last, now.getTime());

  if (action === 'in' && open) return fail(res, 409, 'already_in', { since: localTime(last.ts) });
  if (action === 'out' && !open) return fail(res, 409, 'not_in');

  // الانصراف يُنسب ليوم الدخول (يدعم الورديات الليلية)
  const workDate = action === 'out' ? last.work_date : localDate(now);
  const ts = now.toISOString();
  const info = insertPunch.run(emp.id, action, ts, workDate, 'self', clean(req.ip, 60), '');

  const summary = dailySummary(getMovements({ employeeId: emp.id, from: workDate, to: workDate }))[0];
  const record = {
    id: Number(info.lastInsertRowid), employee_id: emp.id, emp_no: emp.emp_no, name: emp.name,
    department: emp.department, type: action, ts, time: localTime(ts), work_date: workDate,
  };
  broadcast('punch', record);
  res.json({ ok: true, record, today: summary || null });
});

/* ============ دخول الموارد البشرية ============ */
app.post('/api/hr/login', async (req, res) => {
  const username = clean(req.body?.username, 50);
  const password = String(req.body?.password ?? '');
  const key = `hr:${req.ip}`;
  const wait = tooManyAttempts(key);
  if (wait) return fail(res, 429, 'too_many_attempts', { retry_after: wait });

  const user = db.prepare('SELECT * FROM hr_users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordFailure(key);
    return fail(res, 401, 'invalid_credentials');
  }
  clearFailures(key);
  setSessionCookie(req, res, sign({ uid: user.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }), SESSION_HOURS * 3600);
  res.json({ ok: true, user: { username: user.username, must_change: !!user.must_change } });
});

app.post('/api/hr/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/hr/me', requireHR, (req, res) => {
  res.json({ ok: true, user: { username: req.hr.username, must_change: !!req.hr.must_change }, tz: TZ });
});

app.post('/api/hr/password', requireHR, async (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  if (next.length < 8) return fail(res, 400, 'password_too_short');
  const user = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(req.hr.id);
  if (!(await bcrypt.compare(current, user.password_hash))) return fail(res, 401, 'wrong_password');
  db.prepare('UPDATE hr_users SET password_hash = ?, must_change = 0 WHERE id = ?')
    .run(await bcrypt.hash(next, 10), user.id);
  res.json({ ok: true });
});

/* ============ البث اللحظي للوحة التحكم ============ */
app.get('/api/hr/stream', requireHR, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/* ============ الملخص اللحظي ============ */
app.get('/api/hr/overview', requireHR, (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : localDate();
  const now = Date.now();
  const employees = db.prepare('SELECT id, emp_no, name, department, job_title FROM employees WHERE active = 1').all();
  const summaries = new Map(dailySummary(getMovements({ from: date, to: date })).map((s) => [s.employee_id, s]));
  const isToday = date === localDate();

  const list = employees.map((e) => {
    const s = summaries.get(e.id);
    let status = s ? s.status : 'absent';
    // موظف في وردية ليلية بدأت أمس وما زال داخل العمل
    if (isToday && status !== 'in') {
      const last = lastPunch.get(e.id);
      if (isOpen(last, now) && last.work_date !== date) status = 'in';
    }
    return {
      ...e, status,
      first_in: s?.first_in_time || '', last_out: s?.status === 'out' ? s.last_out_time : '',
      hours: s?.hours || '0:00', minutes: s?.minutes || 0,
    };
  }).sort((a, b) => a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));

  const stats = {
    total: list.length,
    in: list.filter((x) => x.status === 'in').length,
    out: list.filter((x) => x.status === 'out').length,
    absent: list.filter((x) => x.status === 'absent').length,
  };
  res.json({ ok: true, date, stats, employees: list, recent: getMovements({ from: date, to: date, limit: 30 }) });
});

/* ============ السجلات ============ */
function rangeFromQuery(q) {
  const today = localDate();
  const to = isDate(q.to) ? q.to : today;
  const from = isDate(q.from) ? q.from : addDays(to, -6);
  return from <= to ? { from, to } : { from: to, to: from };
}

app.get('/api/hr/records', requireHR, (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const q = clean(req.query.q, 50);
  const view = req.query.view === 'summary' ? 'summary' : 'movements';
  const movements = getMovements({ from, to, q, limit: view === 'movements' ? 1000 : undefined });
  res.json({ ok: true, from, to, view, rows: view === 'summary' ? dailySummary(movements) : movements });
});

app.post('/api/hr/records', requireHR, (req, res) => {
  const emp = findEmployee.get(clean(req.body?.emp_no, 30));
  const { type, date, time } = req.body || {};
  if (!emp) return fail(res, 404, 'employee_not_found');
  if (!['in', 'out'].includes(type) || !isDate(date) || !isTime(time)) return fail(res, 400, 'invalid_fields');
  const ts = localToUtcIso(date, time);
  const info = insertPunch.run(emp.id, type, ts, date, 'hr', '', clean(req.body?.note, 200) || `by ${req.hr.username}`);
  const record = { id: Number(info.lastInsertRowid), employee_id: emp.id, emp_no: emp.emp_no, name: emp.name,
    department: emp.department, type, ts, time: localTime(ts), work_date: date, source: 'hr' };
  broadcast('punch', record);
  res.json({ ok: true, record });
});

app.delete('/api/hr/records/:id', requireHR, (req, res) => {
  const r = db.prepare('DELETE FROM attendance WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return fail(res, 404, 'not_found');
  broadcast('refresh', {});
  res.json({ ok: true });
});

/* ============ إدارة الموظفين ============ */
app.get('/api/hr/employees', requireHR, (req, res) => {
  const rows = db.prepare(`SELECT id, emp_no, name, department, job_title, active, created_at FROM employees`).all()
    .sort((a, b) => b.active - a.active || a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));
  res.json({ ok: true, employees: rows });
});

app.post('/api/hr/employees', requireHR, async (req, res) => {
  const emp_no = clean(req.body?.emp_no, 30);
  const name = clean(req.body?.name, 100);
  const pin = clean(req.body?.pin, 10);
  if (!emp_no || !name) return fail(res, 400, 'missing_fields');
  if (!validPin(pin)) return fail(res, 400, 'invalid_pin');
  if (findEmployee.get(emp_no)) return fail(res, 409, 'emp_no_exists');
  const info = db.prepare('INSERT INTO employees(emp_no, name, department, job_title, pin_hash) VALUES (?,?,?,?,?)')
    .run(emp_no, name, clean(req.body?.department), clean(req.body?.job_title), await bcrypt.hash(pin, 10));
  broadcast('refresh', {});
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.put('/api/hr/employees/:id', requireHR, async (req, res) => {
  const id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) return fail(res, 404, 'not_found');
  const b = req.body || {};
  const emp_no = b.emp_no !== undefined ? clean(b.emp_no, 30) : emp.emp_no;
  const name = b.name !== undefined ? clean(b.name, 100) : emp.name;
  if (!emp_no || !name) return fail(res, 400, 'missing_fields');
  const other = findEmployee.get(emp_no);
  if (other && other.id !== id) return fail(res, 409, 'emp_no_exists');
  let pinHash = emp.pin_hash;
  if (b.pin) {
    if (!validPin(String(b.pin))) return fail(res, 400, 'invalid_pin');
    pinHash = await bcrypt.hash(String(b.pin), 10);
  }
  db.prepare('UPDATE employees SET emp_no=?, name=?, department=?, job_title=?, pin_hash=?, active=? WHERE id=?').run(
    emp_no, name,
    b.department !== undefined ? clean(b.department) : emp.department,
    b.job_title !== undefined ? clean(b.job_title) : emp.job_title,
    pinHash,
    b.active !== undefined ? (b.active ? 1 : 0) : emp.active,
    id);
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.delete('/api/hr/employees/:id', requireHR, (req, res) => {
  const r = db.prepare('DELETE FROM employees WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return fail(res, 404, 'not_found');
  broadcast('refresh', {});
  res.json({ ok: true });
});

/* ============ رفع الموظفين من ملف Excel / CSV ============ */
const HEADER_ALIASES = {
  emp_no: ['emp_no', 'emp no', 'employee no', 'employee number', 'employee id', 'id', 'الرقم الوظيفي', 'رقم الموظف', 'الرقم'],
  name: ['name', 'employee name', 'full name', 'الاسم', 'اسم الموظف'],
  department: ['department', 'dept', 'القسم', 'الإدارة'],
  job_title: ['job_title', 'job title', 'title', 'position', 'المسمى', 'المسمى الوظيفي', 'الوظيفة'],
  pin: ['pin', 'password', 'الرمز', 'الرمز السري', 'الرقم السري'],
};
const norm = (s) => String(s).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

app.post('/api/hr/employees/import', requireHR,
  express.raw({ type: 'application/octet-stream', limit: '5mb' }),
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, 'empty_file');
    let rows;
    try {
      rows = buf[0] === 0x50 && buf[1] === 0x4b ? readXlsx(buf) : parseCsv(buf.toString('utf8'));
    } catch { return fail(res, 400, 'unreadable_file'); }
    if (rows.length < 2) return fail(res, 400, 'empty_file');

    const header = rows[0].map(norm);
    const idx = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      idx[field] = header.findIndex((h) => aliases.map(norm).includes(h));
    }
    if (idx.emp_no < 0 || idx.name < 0) return fail(res, 400, 'missing_columns');

    const result = { added: 0, updated: 0, errors: [] };
    const insert = db.prepare('INSERT INTO employees(emp_no, name, department, job_title, pin_hash) VALUES (?,?,?,?,?)');
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const val = (f) => (idx[f] >= 0 ? clean(r[idx[f]]) : '');
      const emp_no = val('emp_no').replace(/\.0+$/, '');
      const name = val('name');
      const pin = val('pin').replace(/\.0+$/, '');
      if (!emp_no && !name) continue;
      if (!emp_no || !name) { result.errors.push({ row: i + 1, error: 'missing_fields' }); continue; }
      if (pin && !validPin(pin)) { result.errors.push({ row: i + 1, emp_no, error: 'invalid_pin' }); continue; }

      const existing = findEmployee.get(emp_no);
      if (existing) {
        db.prepare('UPDATE employees SET name=?, department=?, job_title=?, pin_hash=? WHERE id=?').run(
          name,
          idx.department >= 0 ? val('department') : existing.department,
          idx.job_title >= 0 ? val('job_title') : existing.job_title,
          pin ? bcrypt.hashSync(pin, 10) : existing.pin_hash,
          existing.id);
        result.updated++;
      } else {
        if (!pin) { result.errors.push({ row: i + 1, emp_no, error: 'invalid_pin' }); continue; }
        insert.run(emp_no, name, val('department'), val('job_title'), bcrypt.hashSync(pin, 10));
        result.added++;
      }
    }
    broadcast('refresh', {});
    res.json({ ok: true, ...result });
  });

// قالب جاهز لرفع الموظفين
app.get('/api/hr/template', requireHR, (req, res) => {
  const columns = [
    { key: 'emp_no', header: 'emp_no', width: 14 }, { key: 'name', header: 'name', width: 26 },
    { key: 'department', header: 'department', width: 18 }, { key: 'job_title', header: 'job_title', width: 18 },
    { key: 'pin', header: 'pin', width: 10 },
  ];
  const rows = [{ emp_no: '1001', name: 'أحمد سالم', department: 'المالية', job_title: 'محاسب', pin: '1234' }];
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees_template.csv"');
    return res.send(toCsv(columns, rows));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="employees_template.xlsx"');
  res.send(buildXlsx([{ name: 'Employees', columns, rows }]));
});

/* ============ تصدير التقارير ============ */
const LABELS = {
  ar: {
    movements: 'الحركات', summary: 'الملخص اليومي', emp_no: 'الرقم الوظيفي', name: 'الاسم', department: 'القسم',
    date: 'التاريخ', time: 'الوقت', type: 'الحركة', source: 'المصدر', note: 'ملاحظة', first_in: 'أول دخول',
    last_out: 'آخر خروج', hours: 'ساعات العمل', hours_dec: 'الساعات (رقم)', status: 'الحالة',
    in: 'حضور', out: 'انصراف', self: 'الموظف', hr: 'الموارد البشرية', still_in: 'لم ينصرف', done: 'منصرف',
  },
  en: {
    movements: 'Movements', summary: 'Daily Summary', emp_no: 'Employee No', name: 'Name', department: 'Department',
    date: 'Date', time: 'Time', type: 'Action', source: 'Source', note: 'Note', first_in: 'First In',
    last_out: 'Last Out', hours: 'Worked Hours', hours_dec: 'Hours (decimal)', status: 'Status',
    in: 'Check-in', out: 'Check-out', self: 'Employee', hr: 'HR', still_in: 'Still in', done: 'Checked out',
  },
};

app.get('/api/hr/export', requireHR, (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const lang = req.query.lang === 'en' ? 'en' : 'ar';
  const L = LABELS[lang];
  const q = clean(req.query.q, 50);
  const movements = getMovements({ from, to, q }).reverse();
  const summary = dailySummary(movements).reverse();

  const movCols = [
    { key: 'emp_no', header: L.emp_no, width: 14 }, { key: 'name', header: L.name, width: 26 },
    { key: 'department', header: L.department, width: 18 }, { key: 'work_date', header: L.date, width: 13 },
    { key: 'time', header: L.time, width: 11 }, { key: 'type_label', header: L.type, width: 12 },
    { key: 'source_label', header: L.source, width: 16 }, { key: 'note', header: L.note, width: 22 },
  ];
  const movRows = movements.map((m) => ({ ...m, type_label: L[m.type], source_label: L[m.source] || m.source }));
  const sumCols = [
    { key: 'work_date', header: L.date, width: 13 }, { key: 'emp_no', header: L.emp_no, width: 14 },
    { key: 'name', header: L.name, width: 26 }, { key: 'department', header: L.department, width: 18 },
    { key: 'first_in_time', header: L.first_in, width: 12 }, { key: 'last_out_time', header: L.last_out, width: 12 },
    { key: 'hours', header: L.hours, width: 13 }, { key: 'hours_dec', header: L.hours_dec, width: 15 },
    { key: 'status_label', header: L.status, width: 13 },
  ];
  const sumRows = summary.map((s) => ({
    ...s, hours_dec: Math.round((s.minutes / 60) * 100) / 100, status_label: s.status === 'in' ? L.still_in : L.done,
  }));

  const base = `attendance_${from}_to_${to}`;
  if (req.query.format === 'csv') {
    const isSummary = req.query.view === 'summary';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}${isSummary ? '_summary' : ''}.csv"`);
    return res.send(isSummary ? toCsv(sumCols, sumRows) : toCsv(movCols, movRows));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  res.send(buildXlsx([
    { name: L.summary, rtl: lang === 'ar', columns: sumCols, rows: sumRows },
    { name: L.movements, rtl: lang === 'ar', columns: movCols, rows: movRows },
  ]));
});

/* ============ الصفحات ============ */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/hr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'hr.html')));
app.use('/api', (req, res) => fail(res, 404, 'not_found'));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return fail(res, 413, 'file_too_large');
  fail(res, 500, 'server_error');
});

app.listen(PORT, () => console.log(`HR Attendance running on port ${PORT} (timezone: ${TZ})`));

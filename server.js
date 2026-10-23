// server.js — الخادم الرئيسي لنظام الحضور والانصراف
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { db, sessionSecret, getSetting, setSetting, workSettings } = require('./lib/db');
const {
  TZ, localDate, localTime, hhmmTo12, isDate, isTime, addDays, weekday, localToUtcIso,
} = require('./lib/time');
const { getMovements, dailySummary, excuseIndex, holidayIndex, periodSummary } = require('./lib/report');
const { checkLocation, validCoord, activeSites } = require('./lib/geo');
const { buildXlsx, readXlsx } = require('./lib/xlsx');
const { toCsv, parseCsv } = require('./lib/csv');
const { sendMail, isConfigured, parseEmails, validEmails, mailConfig } = require('./lib/mailer');
const { REPEATS, sendReminder, startScheduler } = require('./lib/reminders');

const PORT = process.env.PORT || 3000;
const SECRET = sessionSecret();
const OPEN_SHIFT_HOURS = 16; // بعدها يُعتبر الدخول المفتوح منتهيًا (نسي تسجيل الانصراف)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-pin', 10);
const EXCUSE_TYPES = ['medical', 'personal', 'late', 'early_leave', 'absence', 'other'];
const ATTACH_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX_ATTACH = 3 * 1024 * 1024;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '6mb' }));

/* ============ أدوات مساعدة ============ */
const fail = (res, status, code, extra = {}) => res.status(status).json({ ok: false, error: code, ...extra });
const validPin = (p) => typeof p === 'string' && /^\d{4,6}$/.test(p);
const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);

// تحديد عدد المحاولات الخاطئة (حماية من التخمين)
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (a && a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
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

// قراءة المرفق (صورة أو PDF بصيغة base64)
function parseAttachment(att) {
  if (!att || !att.data) return { ok: true, file: null };
  const type = clean(att.type, 50).toLowerCase();
  if (!ATTACH_TYPES.includes(type)) return { ok: false, error: 'invalid_attachment' };
  const buf = Buffer.from(String(att.data).replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) return { ok: false, error: 'invalid_attachment' };
  if (buf.length > MAX_ATTACH) return { ok: false, error: 'file_too_large' };
  return { ok: true, file: { data: buf, name: clean(att.name, 120) || 'attachment', type } };
}

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
  for (const part of (req.headers.cookie || '').split(';')) {
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
// الصلاحيات: admin = مدير النظام، hr = موظف موارد بشرية، viewer = مشاهد فقط
const ROLES = ['admin', 'hr', 'viewer'];
const VIEWER_ALLOWED_WRITES = ['/api/hr/logout', '/api/hr/password'];

function requireHR(req, res, next) {
  const s = verify(getCookie(req, COOKIE));
  if (!s) return fail(res, 401, 'unauthorized');
  const user = db.prepare('SELECT id, username, must_change, role, active FROM hr_users WHERE id = ?').get(s.uid);
  if (!user || !user.active) return fail(res, 401, 'unauthorized');
  req.hr = user;
  // المشاهد يقرأ ويصدّر فقط
  if (user.role === 'viewer' && req.method !== 'GET' && !VIEWER_ALLOWED_WRITES.includes(req.path)) {
    return fail(res, 403, 'forbidden');
  }
  next();
}
const adminOnly = (req, res, next) => (req.hr.role === 'admin' ? next() : fail(res, 403, 'forbidden'));

// سجل التعديلات: من فعل ماذا ومتى
function audit(req, action, target = '', details = null) {
  db.prepare('INSERT INTO audit_log(user_id, username, action, target, details) VALUES (?,?,?,?,?)')
    .run(req.hr?.id ?? null, req.hr?.username || 'system', action, String(target).slice(0, 200),
      details ? JSON.stringify(details).slice(0, 4000) : '');
}
// الفروقات بين قيمتين قديمة وجديدة لحقول محددة
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (after[f] !== undefined && String(before[f] ?? '') !== String(after[f] ?? '')) out[f] = [before[f], after[f]];
  return Object.keys(out).length ? out : null;
}

// إنشاء حساب المدير الأول عند أول تشغيل
(function seedAdmin() {
  if (db.prepare('SELECT COUNT(*) AS c FROM hr_users').get().c > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin1234';
  db.prepare("INSERT INTO hr_users(username, password_hash, must_change, role, created_at) VALUES (?,?,?, 'admin', ?)")
    .run(username, bcrypt.hashSync(password, 10), process.env.ADMIN_PASSWORD ? 0 : 1, new Date().toISOString());
  console.log(`[setup] HR admin created: ${username}${process.env.ADMIN_PASSWORD ? '' : ' (default password, change it after login)'}`);
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
  res.json({ ok: true, now: new Date().toISOString(), tz: TZ, date: localDate(), time: localTime(),
    company: getSetting('company_name') });
});

app.get('/api/work-hours', (req, res) => {
  const s = workSettings();
  const today = localDate();
  const next = db.prepare('SELECT name, date_from, date_to FROM holidays WHERE date_to >= ? ORDER BY date_from LIMIT 1').get(today);
  res.json({ ok: true, start: hhmmTo12(s.work_start), end: hhmmTo12(s.work_end),
    geo_required: activeSites().length > 0, next_holiday: next || null });
});

/* ============ الموظف: التحقق من الرقم والرمز ============ */
const findEmployee = db.prepare('SELECT * FROM employees WHERE emp_no = ?');
const lastPunch = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY ts DESC, id DESC LIMIT 1');
const insertPunch = db.prepare(`INSERT INTO attendance(employee_id, type, ts, work_date, source, ip, note,
  lat, lng, accuracy, distance, site_id, site_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

async function authEmployee(req, res) {
  const empNo = clean(req.body?.emp_no, 30);
  const pin = clean(req.body?.pin, 10);
  if (!empNo || !pin) { fail(res, 400, 'missing_fields'); return null; }
  const key = `emp:${req.ip}:${empNo}`;
  const wait = tooManyAttempts(key);
  if (wait) { fail(res, 429, 'too_many_attempts', { retry_after: wait }); return null; }
  const emp = findEmployee.get(empNo);
  // نقارن دائمًا (حتى لو لم يوجد الموظف) حتى لا يُكشف وجود الرقم من زمن الاستجابة
  const okPin = await bcrypt.compare(pin, emp ? emp.pin_hash : DUMMY_HASH);
  if (!emp || !okPin) { recordFailure(key); fail(res, 401, 'invalid_credentials'); return null; }
  if (!emp.active) { fail(res, 403, 'inactive'); return null; }
  clearFailures(key);
  return emp;
}

function isOpen(last, now = Date.now()) {
  return !!last && last.type === 'in' && now - new Date(last.ts).getTime() < OPEN_SHIFT_HOURS * 3600 * 1000;
}

/* ============ تسجيل الحضور والانصراف ============ */
app.post('/api/punch', async (req, res) => {
  const action = req.body?.action;
  if (!['in', 'out'].includes(action)) return fail(res, 400, 'invalid_action');
  const emp = await authEmployee(req, res);
  if (!emp) return;

  const now = new Date();
  const last = lastPunch.get(emp.id);
  const open = isOpen(last, now.getTime());
  if (action === 'in' && open) return fail(res, 409, 'already_in', { since: localTime(last.ts) });
  if (action === 'out' && !open) return fail(res, 409, 'not_in');

  // التحقق من الموقع الجغرافي
  const loc = req.body?.location || {};
  const pos = { lat: Number(loc.lat), lng: Number(loc.lng), accuracy: Number(loc.accuracy) };
  const geo = checkLocation(emp, pos);
  if (!geo.ok) return fail(res, 403, geo.error, { distance: geo.distance, site: geo.site_name });
  const hasPos = validCoord(pos.lat, pos.lng);

  // الانصراف يُنسب ليوم الدخول (يدعم الورديات الليلية)
  const workDate = action === 'out' ? last.work_date : localDate(now);
  const ts = now.toISOString();
  const info = insertPunch.run(emp.id, action, ts, workDate, 'self', clean(req.ip, 60), '',
    hasPos ? pos.lat : null, hasPos ? pos.lng : null, Number.isFinite(pos.accuracy) ? Math.round(pos.accuracy) : null,
    geo.distance != null ? Math.round(geo.distance) : null, geo.site ? geo.site.id : null, geo.site ? geo.site.name : '');

  const summary = dailySummary(getMovements({ employeeId: emp.id, from: workDate, to: workDate }))[0];
  const record = {
    id: Number(info.lastInsertRowid), employee_id: emp.id, emp_no: emp.emp_no, name: emp.name,
    department: emp.department, type: action, ts, time: localTime(ts), work_date: workDate,
    site_name: geo.site ? geo.site.name : '',
  };
  broadcast('punch', record);
  res.json({ ok: true, record, today: summary || null });
});

/* ============ الموظف: الأعذار ============ */
app.post('/api/excuses', async (req, res) => {
  const b = req.body || {};
  if (!EXCUSE_TYPES.includes(b.type) || !isDate(b.date_from)) return fail(res, 400, 'invalid_fields');
  const dateTo = isDate(b.date_to) ? b.date_to : b.date_from;
  if (dateTo < b.date_from) return fail(res, 400, 'invalid_dates');
  const att = parseAttachment(b.attachment);
  if (!att.ok) return fail(res, 400, att.error);
  const emp = await authEmployee(req, res);
  if (!emp) return;

  const info = db.prepare(`INSERT INTO excuses(employee_id, type, date_from, date_to, reason, attachment, attachment_name, attachment_type, submitted_by)
    VALUES (?,?,?,?,?,?,?,?, 'employee')`).run(emp.id, b.type, b.date_from, dateTo, clean(b.reason, 1000),
    att.file ? att.file.data : null, att.file ? att.file.name : '', att.file ? att.file.type : '');
  broadcast('excuse', { id: Number(info.lastInsertRowid), name: emp.name, type: b.type });
  res.json({ ok: true, name: emp.name });
});

app.post('/api/my/excuses', async (req, res) => {
  const emp = await authEmployee(req, res);
  if (!emp) return;
  const rows = db.prepare(`SELECT id, type, date_from, date_to, status, hr_note, created_at FROM excuses
    WHERE employee_id = ? ORDER BY id DESC LIMIT 10`).all(emp.id);
  res.json({ ok: true, name: emp.name, excuses: rows });
});

/* ============ دخول الموارد البشرية ============ */
app.post('/api/hr/login', async (req, res) => {
  const username = clean(req.body?.username, 50);
  const password = String(req.body?.password ?? '');
  const key = `hr:${req.ip}`;
  const wait = tooManyAttempts(key);
  if (wait) return fail(res, 429, 'too_many_attempts', { retry_after: wait });
  const user = db.prepare('SELECT * FROM hr_users WHERE username = ?').get(username);
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    recordFailure(key);
    return fail(res, 401, 'invalid_credentials');
  }
  clearFailures(key);
  setSessionCookie(req, res, sign({ uid: user.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }), SESSION_HOURS * 3600);
  req.hr = user;
  audit(req, 'auth.login');
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, must_change: !!user.must_change } });
});

app.post('/api/hr/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/hr/me', requireHR, (req, res) => {
  res.json({ ok: true, user: { id: req.hr.id, username: req.hr.username, role: req.hr.role, must_change: !!req.hr.must_change }, tz: TZ });
});

app.post('/api/hr/password', requireHR, async (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  if (next.length < 8) return fail(res, 400, 'password_too_short');
  const user = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(req.hr.id);
  if (!(await bcrypt.compare(current, user.password_hash))) return fail(res, 401, 'wrong_password');
  db.prepare('UPDATE hr_users SET password_hash = ?, must_change = 0 WHERE id = ?').run(await bcrypt.hash(next, 10), user.id);
  audit(req, 'auth.password');
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
const pendingCount = () => db.prepare("SELECT COUNT(*) AS c FROM excuses WHERE status = 'pending'").get().c;

app.get('/api/hr/overview', requireHR, (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : localDate();
  const settings = workSettings();
  const now = Date.now();
  const isToday = date === localDate();
  const holiday = holidayIndex(date, date).find(date);
  const dayOff = settings.weekend.includes(weekday(date)) || !!holiday;
  const excuses = excuseIndex(date, date);
  const employees = db.prepare('SELECT id, emp_no, name, department, job_title FROM employees WHERE active = 1').all();
  const summaries = new Map(dailySummary(getMovements({ from: date, to: date }), { settings, excuses })
    .map((s) => [s.employee_id, s]));

  const list = employees.map((e) => {
    const s = summaries.get(e.id);
    let status = s ? s.status : 'absent';
    if (isToday && status !== 'in') {
      const last = lastPunch.get(e.id);
      if (isOpen(last, now) && last.work_date !== date) status = 'in'; // وردية ليلية بدأت أمس
    }
    const exc = excuses.find(e.id, date);
    if (status === 'absent' && exc) status = 'excused';
    if (status === 'absent' && holiday) status = 'holiday';
    else if (status === 'absent' && dayOff) status = 'off';
    return {
      ...e, status,
      first_in: s?.first_in_time || '', last_out: s?.status === 'out' ? s.last_out_time : '',
      hours: s?.hours || '0:00', late_minutes: s?.late_minutes || 0, early_minutes: s?.early_minutes || 0,
      excuse_type: exc ? exc.type : '',
    };
  }).sort((a, b) => a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));

  const count = (st) => list.filter((x) => x.status === st).length;
  res.json({
    ok: true, date, day_off: dayOff, holiday: holiday ? holiday.name : '', weekend: settings.weekend,
    work: { start: hhmmTo12(settings.work_start), end: hhmmTo12(settings.work_end), grace: settings.grace },
    stats: {
      total: list.length, in: count('in'), out: count('out'), absent: count('absent'), excused: count('excused'),
      late: list.filter((x) => x.late_minutes > 0 && !x.excuse_type).length,
    },
    pending_excuses: pendingCount(),
    employees: list,
    recent: getMovements({ from: date, to: date, limit: 30 }),
  });
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
  const view = ['summary', 'period'].includes(req.query.view) ? req.query.view : 'movements';
  let rows;
  if (view === 'period') rows = periodSummary(from, to, { q });
  else if (view === 'summary') rows = dailySummary(getMovements({ from, to, q }));
  else rows = getMovements({ from, to, q, limit: 1000 });
  res.json({ ok: true, from, to, view, rows });
});

app.post('/api/hr/records', requireHR, (req, res) => {
  const emp = findEmployee.get(clean(req.body?.emp_no, 30));
  const { type, date, time } = req.body || {};
  if (!emp) return fail(res, 404, 'employee_not_found');
  if (!['in', 'out'].includes(type) || !isDate(date) || !isTime(time)) return fail(res, 400, 'invalid_fields');
  const ts = localToUtcIso(date, time);
  const info = insertPunch.run(emp.id, type, ts, date, 'hr', '', clean(req.body?.note, 200) || `by ${req.hr.username}`,
    null, null, null, null, null, '');
  audit(req, 'record.create', `${emp.name} (#${emp.emp_no})`, { type, date, time });
  const record = { id: Number(info.lastInsertRowid), employee_id: emp.id, emp_no: emp.emp_no, name: emp.name,
    department: emp.department, type, ts, time: localTime(ts), work_date: date, source: 'hr' };
  broadcast('punch', record);
  res.json({ ok: true, record });
});

app.delete('/api/hr/records/:id', requireHR, (req, res) => {
  const rec = db.prepare(`SELECT a.*, e.name, e.emp_no FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`)
    .get(Number(req.params.id));
  if (!rec) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM attendance WHERE id = ?').run(rec.id);
  audit(req, 'record.delete', `${rec.name} (#${rec.emp_no})`, { type: rec.type, date: rec.work_date, time: localTime(rec.ts) });
  broadcast('refresh', {});
  res.json({ ok: true });
});

/* ============ الأعذار (الموارد البشرية) ============ */
app.get('/api/hr/excuses', requireHR, (req, res) => {
  const where = [];
  const params = [];
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) { where.push('x.status = ?'); params.push(req.query.status); }
  const q = clean(req.query.q, 50);
  if (q) { where.push('(e.emp_no LIKE ? OR e.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT x.id, x.type, x.date_from, x.date_to, x.reason, x.status, x.hr_note, x.submitted_by,
      x.decided_by, x.decided_at, x.created_at, x.attachment_name, x.attachment_type,
      (x.attachment IS NOT NULL) AS has_attachment, e.emp_no, e.name, e.department
    FROM excuses x JOIN employees e ON e.id = x.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE x.status WHEN 'pending' THEN 0 ELSE 1 END, x.id DESC LIMIT 300`).all(...params)
    .map((r) => ({ ...r, has_attachment: !!r.has_attachment,
      created_label: `${localDate(r.created_at)} ${localTime(r.created_at)}`,
      decided_label: r.decided_at ? `${localDate(r.decided_at)} ${localTime(r.decided_at)}` : '' }));
  res.json({ ok: true, excuses: rows, pending: pendingCount() });
});

app.post('/api/hr/excuses', requireHR, (req, res) => {
  const b = req.body || {};
  const emp = findEmployee.get(clean(b.emp_no, 30));
  if (!emp) return fail(res, 404, 'employee_not_found');
  if (!EXCUSE_TYPES.includes(b.type) || !isDate(b.date_from)) return fail(res, 400, 'invalid_fields');
  const dateTo = isDate(b.date_to) ? b.date_to : b.date_from;
  if (dateTo < b.date_from) return fail(res, 400, 'invalid_dates');
  const status = ['approved', 'rejected'].includes(b.status) ? b.status : 'pending';
  const att = parseAttachment(b.attachment);
  if (!att.ok) return fail(res, 400, att.error);
  const decided = status !== 'pending';
  db.prepare(`INSERT INTO excuses(employee_id, type, date_from, date_to, reason, attachment, attachment_name, attachment_type,
      status, hr_note, submitted_by, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'hr', ?, ?)`)
    .run(emp.id, b.type, b.date_from, dateTo, clean(b.reason, 1000),
      att.file ? att.file.data : null, att.file ? att.file.name : '', att.file ? att.file.type : '',
      status, clean(b.hr_note, 500), decided ? req.hr.username : '', decided ? new Date().toISOString() : '');
  audit(req, 'excuse.create', `${emp.name} (#${emp.emp_no})`, { type: b.type, from: b.date_from, to: dateTo, status });
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.put('/api/hr/excuses/:id', requireHR, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT x.*, e.name, e.emp_no FROM excuses x JOIN employees e ON e.id = x.employee_id WHERE x.id = ?').get(id);
  if (!ex) return fail(res, 404, 'not_found');
  const status = req.body?.status;
  if (!['pending', 'approved', 'rejected'].includes(status)) return fail(res, 400, 'invalid_fields');
  const decided = status !== 'pending';
  db.prepare('UPDATE excuses SET status=?, hr_note=?, decided_by=?, decided_at=? WHERE id=?').run(
    status, clean(req.body?.hr_note, 500), decided ? req.hr.username : '', decided ? new Date().toISOString() : '', id);
  audit(req, 'excuse.' + status, `${ex.name} (#${ex.emp_no})`, { type: ex.type, from: ex.date_from, to: ex.date_to, note: clean(req.body?.hr_note, 500) || undefined });
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.delete('/api/hr/excuses/:id', requireHR, (req, res) => {
  const ex = db.prepare('SELECT x.*, e.name, e.emp_no FROM excuses x JOIN employees e ON e.id = x.employee_id WHERE x.id = ?').get(Number(req.params.id));
  if (!ex) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM excuses WHERE id = ?').run(ex.id);
  audit(req, 'excuse.delete', `${ex.name} (#${ex.emp_no})`, { type: ex.type, from: ex.date_from, to: ex.date_to });
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.get('/api/hr/excuses/:id/attachment', requireHR, (req, res) => {
  const r = db.prepare('SELECT attachment, attachment_name, attachment_type FROM excuses WHERE id = ?').get(Number(req.params.id));
  if (!r || !r.attachment) return fail(res, 404, 'not_found');
  res.setHeader('Content-Type', r.attachment_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.attachment_name || 'attachment')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(r.attachment));
});

/* ============ إدارة الموظفين ============ */
app.get('/api/hr/employees', requireHR, (req, res) => {
  const links = db.prepare('SELECT employee_id, site_id FROM employee_sites').all();
  const rows = db.prepare('SELECT id, emp_no, name, department, job_title, active, geo_mode, created_at FROM employees').all()
    .map((e) => ({ ...e, site_ids: links.filter((l) => l.employee_id === e.id).map((l) => l.site_id) }))
    .sort((a, b) => b.active - a.active || a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));
  res.json({ ok: true, employees: rows });
});

// طريقة التحقق من موقع الموظف والمواقع المسموحة له
const GEO_MODES = ['any', 'assigned', 'exempt'];
function setEmployeeGeo(id, mode, siteIds) {
  if (mode === undefined) return;
  if (!GEO_MODES.includes(mode)) mode = 'any';
  db.prepare('UPDATE employees SET geo_mode = ? WHERE id = ?').run(mode, id);
  db.prepare('DELETE FROM employee_sites WHERE employee_id = ?').run(id);
  if (mode === 'assigned' && Array.isArray(siteIds)) {
    const ins = db.prepare('INSERT OR IGNORE INTO employee_sites(employee_id, site_id) SELECT ?, id FROM sites WHERE id = ?');
    for (const s of siteIds.slice(0, 50)) ins.run(id, Number(s));
  }
}

app.post('/api/hr/employees', requireHR, async (req, res) => {
  const emp_no = clean(req.body?.emp_no, 30);
  const name = clean(req.body?.name, 100);
  const pin = clean(req.body?.pin, 10);
  if (!emp_no || !name) return fail(res, 400, 'missing_fields');
  if (!validPin(pin)) return fail(res, 400, 'invalid_pin');
  if (findEmployee.get(emp_no)) return fail(res, 409, 'emp_no_exists');
  const info = db.prepare('INSERT INTO employees(emp_no, name, department, job_title, pin_hash) VALUES (?,?,?,?,?)')
    .run(emp_no, name, clean(req.body?.department), clean(req.body?.job_title), await bcrypt.hash(pin, 10));
  const newId = Number(info.lastInsertRowid);
  setEmployeeGeo(newId, req.body?.geo_mode, req.body?.site_ids);
  audit(req, 'employee.create', `${name} (#${emp_no})`);
  broadcast('refresh', {});
  res.json({ ok: true, id: newId });
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
    pinHash, b.active !== undefined ? (b.active ? 1 : 0) : emp.active, id);
  const beforeSites = db.prepare('SELECT site_id FROM employee_sites WHERE employee_id = ? ORDER BY site_id').all(id).map((r) => r.site_id).join(',');
  setEmployeeGeo(id, b.geo_mode, b.site_ids);
  const afterSites = db.prepare('SELECT site_id FROM employee_sites WHERE employee_id = ? ORDER BY site_id').all(id).map((r) => r.site_id).join(',');
  const changes = diff(emp, { emp_no, name, department: b.department, job_title: b.job_title,
    active: b.active !== undefined ? (b.active ? 1 : 0) : undefined, geo_mode: b.geo_mode },
  ['emp_no', 'name', 'department', 'job_title', 'active', 'geo_mode']) || {};
  if (b.pin) changes.pin = ['•••', '•••'];
  if (beforeSites !== afterSites) changes.sites = [beforeSites, afterSites];
  if (Object.keys(changes).length) audit(req, 'employee.update', `${name} (#${emp_no})`, changes);
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.delete('/api/hr/employees/:id', requireHR, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!emp) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM employees WHERE id = ?').run(emp.id);
  audit(req, 'employee.delete', `${emp.name} (#${emp.emp_no})`);
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
          pin ? bcrypt.hashSync(pin, 10) : existing.pin_hash, existing.id);
        result.updated++;
      } else {
        if (!pin) { result.errors.push({ row: i + 1, emp_no, error: 'invalid_pin' }); continue; }
        insert.run(emp_no, name, val('department'), val('job_title'), bcrypt.hashSync(pin, 10));
        result.added++;
      }
    }
    audit(req, 'employee.import', '', { added: result.added, updated: result.updated, errors: result.errors.length });
    broadcast('refresh', {});
    res.json({ ok: true, ...result });
  });

app.get('/api/hr/template', requireHR, (req, res) => {
  const columns = [
    { key: 'emp_no', header: 'emp_no', width: 14 }, { key: 'name', header: 'name', width: 26 },
    { key: 'department', header: 'department', width: 18 }, { key: 'job_title', header: 'job_title', width: 18 },
    { key: 'pin', header: 'pin', width: 10 },
  ];
  const rows = [{ emp_no: '1001', name: 'Ahmed Salim', department: 'Finance', job_title: 'Accountant', pin: '1234' }];
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees_template.csv"');
    return res.send(toCsv(columns, rows));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="employees_template.xlsx"');
  res.send(buildXlsx([{ name: 'Employees', columns, rows }]));
});

/* ============ التذكيرات ============ */
function reminderInput(b) {
  const title = clean(b.title, 150);
  const recipients = parseEmails(b.recipients);
  if (!title || !isDate(b.due_date) || !REPEATS[b.repeat]) return { error: 'invalid_fields' };
  if (!validEmails(recipients)) return { error: 'invalid_emails' };
  return {
    title, recipients: recipients.join(', '), due_date: b.due_date, repeat: b.repeat,
    category: ['document', 'contract', 'insurance', 'training', 'other'].includes(b.category) ? b.category : 'other',
    details: clean(b.details, 2000),
    notify_before_days: Math.min(365, Math.max(0, parseInt(b.notify_before_days, 10) || 0)),
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
  };
}

app.get('/api/hr/reminders', requireHR, (req, res) => {
  const reminders = db.prepare('SELECT * FROM reminders ORDER BY active DESC, due_date ASC').all()
    .map((r) => ({ ...r, last_sent_label: r.last_sent_at ? `${localDate(r.last_sent_at)} ${localTime(r.last_sent_at)}` : '' }));
  const logs = db.prepare('SELECT * FROM reminder_logs ORDER BY id DESC LIMIT 30').all()
    .map((l) => ({ ...l, sent_label: `${localDate(l.sent_at)} ${localTime(l.sent_at)}` }));
  res.json({ ok: true, reminders, logs, email_configured: isConfigured(), today: localDate() });
});

app.post('/api/hr/reminders', requireHR, (req, res) => {
  const r = reminderInput(req.body || {});
  if (r.error) return fail(res, 400, r.error);
  const info = db.prepare(`INSERT INTO reminders(title, category, details, recipients, due_date, repeat, notify_before_days, active)
    VALUES (?,?,?,?,?,?,?,?)`).run(r.title, r.category, r.details, r.recipients, r.due_date, r.repeat, r.notify_before_days, r.active);
  audit(req, 'reminder.create', r.title, { due: r.due_date, repeat: r.repeat, to: r.recipients });
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.put('/api/hr/reminders/:id', requireHR, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
  if (!existing) return fail(res, 404, 'not_found');
  const r = reminderInput({ ...existing, ...req.body });
  if (r.error) return fail(res, 400, r.error);
  // تغيير الموعد يعيد تفعيل الإرسال له
  const lastSentFor = r.due_date !== existing.due_date ? '' : existing.last_sent_for;
  db.prepare(`UPDATE reminders SET title=?, category=?, details=?, recipients=?, due_date=?, repeat=?, notify_before_days=?,
    active=?, last_sent_for=? WHERE id=?`).run(r.title, r.category, r.details, r.recipients, r.due_date, r.repeat,
    r.notify_before_days, r.active, lastSentFor, id);
  const changes = diff(existing, r, ['title', 'recipients', 'due_date', 'repeat', 'notify_before_days', 'active', 'category', 'details']);
  if (changes) audit(req, 'reminder.update', r.title, changes);
  res.json({ ok: true });
});

app.delete('/api/hr/reminders/:id', requireHR, (req, res) => {
  const rem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(req.params.id));
  if (!rem) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM reminders WHERE id = ?').run(rem.id);
  audit(req, 'reminder.delete', rem.title);
  res.json({ ok: true });
});

app.post('/api/hr/reminders/:id/send', requireHR, async (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(req.params.id));
  if (!r) return fail(res, 404, 'not_found');
  if (!isConfigured()) return fail(res, 400, 'email_not_configured');
  const result = await sendReminder(r, { test: true });
  if (!result.ok) return fail(res, 502, result.error, { detail: result.detail });
  res.json({ ok: true });
});

/* ============ الإعدادات ============ */
app.get('/api/hr/settings', requireHR, (req, res) => {
  const s = workSettings();
  res.json({
    ok: true,
    settings: {
      company_name: s.company_name, work_start: s.work_start, work_end: s.work_end,
      grace_minutes: s.grace, weekend: s.weekend,
      mail_from: getSetting('mail_from') || '',
      email_configured: isConfigured(),
      email_from_env: !!process.env.RESEND_API_KEY,
    },
  });
});

app.put('/api/hr/settings', requireHR, adminOnly, (req, res) => {
  const b = req.body || {};
  const before = { ...workSettings(), weekend: workSettings().weekend.join(','), grace_minutes: workSettings().grace, mail_from: getSetting('mail_from') };
  if (b.company_name !== undefined) setSetting('company_name', clean(b.company_name, 80) || 'HR Attendance');
  if (b.work_start !== undefined) { if (!isTime(b.work_start)) return fail(res, 400, 'invalid_fields'); setSetting('work_start', b.work_start.slice(0, 5)); }
  if (b.work_end !== undefined) { if (!isTime(b.work_end)) return fail(res, 400, 'invalid_fields'); setSetting('work_end', b.work_end.slice(0, 5)); }
  if (b.grace_minutes !== undefined) setSetting('grace_minutes', Math.min(180, Math.max(0, parseInt(b.grace_minutes, 10) || 0)));
  if (Array.isArray(b.weekend)) setSetting('weekend', b.weekend.map(Number).filter((n) => n >= 0 && n <= 6).join(','));
  if (b.mail_from !== undefined) setSetting('mail_from', clean(b.mail_from, 200));
  if (b.resend_api_key) setSetting('resend_api_key', clean(b.resend_api_key, 200));
  if (b.clear_api_key) setSetting('resend_api_key', '');
  const after = { ...workSettings(), weekend: workSettings().weekend.join(','), grace_minutes: workSettings().grace, mail_from: getSetting('mail_from') };
  const changes = diff(before, after, ['company_name', 'work_start', 'work_end', 'grace_minutes', 'weekend', 'mail_from']) || {};
  if (b.resend_api_key) changes.resend_api_key = ['•••', '•••'];
  if (Object.keys(changes).length) audit(req, 'settings.update', '', changes);
  broadcast('refresh', {});
  res.json({ ok: true });
});

app.post('/api/hr/settings/test-email', requireHR, adminOnly, async (req, res) => {
  const to = parseEmails(req.body?.to);
  if (!validEmails(to)) return fail(res, 400, 'invalid_emails');
  if (!isConfigured()) return fail(res, 400, 'email_not_configured');
  const result = await sendMail({
    to, subject: 'Test email — HR Attendance System',
    html: `<div style="font-family:Arial;padding:20px;border:1px solid #bfdbfe;border-radius:12px"><h2 style="color:#1d4ed8;margin:0 0 8px">It works ✓</h2><p>Email reminders are set up correctly.</p><p dir="rtl">تم إعداد إيميلات التذكير بنجاح.</p></div>`,
    text: 'Email reminders are set up correctly.',
  });
  if (!result.ok) return fail(res, 502, result.error, { detail: result.detail });
  res.json({ ok: true, from: mailConfig().from });
});

/* ============ مواقع العمل (GPS) ============ */
function siteInput(b) {
  const name = clean(b.name, 80);
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const radius = Math.round(Number(b.radius) || 150);
  if (!name || !validCoord(lat, lng) || radius < 20 || radius > 5000) return { error: 'invalid_fields' };
  return { name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radius,
    active: b.active === false || b.active === 0 ? 0 : 1 };
}
app.get('/api/hr/sites', requireHR, (req, res) => {
  const counts = new Map(db.prepare('SELECT site_id, COUNT(*) c FROM employee_sites GROUP BY site_id').all().map((r) => [r.site_id, r.c]));
  const sites = db.prepare('SELECT * FROM sites ORDER BY active DESC, name').all().map((s) => ({ ...s, employees: counts.get(s.id) || 0 }));
  res.json({ ok: true, sites });
});
app.post('/api/hr/sites', requireHR, adminOnly, (req, res) => {
  const s = siteInput(req.body || {});
  if (s.error) return fail(res, 400, s.error);
  const info = db.prepare('INSERT INTO sites(name, lat, lng, radius, active) VALUES (?,?,?,?,?)').run(s.name, s.lat, s.lng, s.radius, s.active);
  audit(req, 'site.create', s.name, { lat: s.lat, lng: s.lng, radius: s.radius });
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/hr/sites/:id', requireHR, adminOnly, (req, res) => {
  const existing = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!existing) return fail(res, 404, 'not_found');
  const s = siteInput({ ...existing, ...req.body });
  if (s.error) return fail(res, 400, s.error);
  db.prepare('UPDATE sites SET name=?, lat=?, lng=?, radius=?, active=? WHERE id=?').run(s.name, s.lat, s.lng, s.radius, s.active, existing.id);
  const changes = diff(existing, s, ['name', 'lat', 'lng', 'radius', 'active']);
  if (changes) audit(req, 'site.update', s.name, changes);
  res.json({ ok: true });
});
app.delete('/api/hr/sites/:id', requireHR, adminOnly, (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  audit(req, 'site.delete', site.name);
  res.json({ ok: true });
});

/* ============ الإجازات الرسمية ============ */
app.get('/api/hr/holidays', requireHR, (req, res) => {
  const year = /^\d{4}$/.test(req.query.year) ? req.query.year : localDate().slice(0, 4);
  const rows = db.prepare('SELECT * FROM holidays WHERE date_to >= ? AND date_from <= ? ORDER BY date_from')
    .all(`${Number(year) - 1}-12-01`, `${Number(year) + 1}-01-31`);
  res.json({ ok: true, holidays: rows, today: localDate() });
});
function holidayInput(b) {
  const name = clean(b.name, 100);
  const from = b.date_from;
  const to = isDate(b.date_to) ? b.date_to : from;
  if (!name || !isDate(from)) return { error: 'invalid_fields' };
  if (to < from) return { error: 'invalid_dates' };
  return { name, date_from: from, date_to: to };
}
app.post('/api/hr/holidays', requireHR, (req, res) => {
  const h = holidayInput(req.body || {});
  if (h.error) return fail(res, 400, h.error);
  const info = db.prepare('INSERT INTO holidays(name, date_from, date_to) VALUES (?,?,?)').run(h.name, h.date_from, h.date_to);
  audit(req, 'holiday.create', h.name, { from: h.date_from, to: h.date_to });
  broadcast('refresh', {});
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/hr/holidays/:id', requireHR, (req, res) => {
  const existing = db.prepare('SELECT * FROM holidays WHERE id = ?').get(Number(req.params.id));
  if (!existing) return fail(res, 404, 'not_found');
  const h = holidayInput({ ...existing, ...req.body });
  if (h.error) return fail(res, 400, h.error);
  db.prepare('UPDATE holidays SET name=?, date_from=?, date_to=? WHERE id=?').run(h.name, h.date_from, h.date_to, existing.id);
  const changes = diff(existing, h, ['name', 'date_from', 'date_to']);
  if (changes) audit(req, 'holiday.update', h.name, changes);
  broadcast('refresh', {});
  res.json({ ok: true });
});
app.delete('/api/hr/holidays/:id', requireHR, (req, res) => {
  const h = db.prepare('SELECT * FROM holidays WHERE id = ?').get(Number(req.params.id));
  if (!h) return fail(res, 404, 'not_found');
  db.prepare('DELETE FROM holidays WHERE id = ?').run(h.id);
  audit(req, 'holiday.delete', h.name, { from: h.date_from, to: h.date_to });
  broadcast('refresh', {});
  res.json({ ok: true });
});

/* ============ حسابات الموارد البشرية ============ */
const adminCount = () => db.prepare("SELECT COUNT(*) c FROM hr_users WHERE role = 'admin' AND active = 1").get().c;
app.get('/api/hr/users', requireHR, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, role, active, must_change, created_at FROM hr_users ORDER BY id').all()
    .map((u) => {
      const last = db.prepare("SELECT ts FROM audit_log WHERE user_id = ? AND action = 'auth.login' ORDER BY id DESC LIMIT 1").get(u.id);
      return { ...u, last_login: last ? `${localDate(last.ts)} ${localTime(last.ts)}` : '' };
    });
  res.json({ ok: true, users });
});
app.post('/api/hr/users', requireHR, adminOnly, async (req, res) => {
  const username = clean(req.body?.username, 50).toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'hr';
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) return fail(res, 400, 'invalid_username');
  if (password.length < 8) return fail(res, 400, 'password_too_short');
  if (db.prepare('SELECT id FROM hr_users WHERE username = ?').get(username)) return fail(res, 409, 'username_exists');
  const info = db.prepare('INSERT INTO hr_users(username, password_hash, must_change, role, created_at) VALUES (?,?,1,?,?)')
    .run(username, await bcrypt.hash(password, 10), role, new Date().toISOString());
  audit(req, 'user.create', username, { role });
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/hr/users/:id', requireHR, adminOnly, async (req, res) => {
  const u = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(Number(req.params.id));
  if (!u) return fail(res, 404, 'not_found');
  const b = req.body || {};
  const role = b.role !== undefined ? (ROLES.includes(b.role) ? b.role : u.role) : u.role;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  // لا يمكن إزالة آخر مدير نظام
  if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && adminCount() <= 1) return fail(res, 400, 'last_admin');
  if (u.id === req.hr.id && (role !== 'admin' || !active)) return fail(res, 400, 'cannot_change_self');
  let hash = u.password_hash;
  let must = u.must_change;
  if (b.password) {
    if (String(b.password).length < 8) return fail(res, 400, 'password_too_short');
    hash = await bcrypt.hash(String(b.password), 10);
    must = 1;
  }
  db.prepare('UPDATE hr_users SET role=?, active=?, password_hash=?, must_change=? WHERE id=?').run(role, active, hash, must, u.id);
  const changes = diff(u, { role, active }, ['role', 'active']) || {};
  if (b.password) changes.password = ['•••', '•••'];
  if (Object.keys(changes).length) audit(req, 'user.update', u.username, changes);
  res.json({ ok: true });
});
app.delete('/api/hr/users/:id', requireHR, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(Number(req.params.id));
  if (!u) return fail(res, 404, 'not_found');
  if (u.id === req.hr.id) return fail(res, 400, 'cannot_change_self');
  if (u.role === 'admin' && u.active && adminCount() <= 1) return fail(res, 400, 'last_admin');
  db.prepare('DELETE FROM hr_users WHERE id = ?').run(u.id);
  audit(req, 'user.delete', u.username);
  res.json({ ok: true });
});

/* ============ سجل التعديلات ============ */
function auditRows({ q, user, from, to, limit }) {
  const where = [];
  const params = [];
  if (user) { where.push('username = ?'); params.push(user); }
  if (q) { where.push('(target LIKE ? OR action LIKE ? OR details LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (from) { where.push('ts >= ?'); params.push(localToUtcIso(from, '00:00')); }
  if (to) { where.push('ts < ?'); params.push(localToUtcIso(addDays(to, 1), '00:00')); }
  let sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params).map((r) => ({
    ...r, date: localDate(r.ts), time: localTime(r.ts), details: r.details ? JSON.parse(r.details) : null,
  }));
}
app.get('/api/hr/audit', requireHR, adminOnly, (req, res) => {
  const rows = auditRows({ q: clean(req.query.q, 60), user: clean(req.query.user, 50),
    from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '', limit: 300 });
  const users = db.prepare('SELECT DISTINCT username FROM audit_log ORDER BY username').all().map((r) => r.username);
  res.json({ ok: true, rows, users });
});
app.get('/api/hr/audit/export', requireHR, adminOnly, (req, res) => {
  const rows = auditRows({ from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '' })
    .map((r) => ({ ...r, details_text: r.details ? Object.entries(r.details).map(([k, v]) =>
      Array.isArray(v) ? `${k}: ${v[0] ?? ''} -> ${v[1] ?? ''}` : `${k}: ${v}`).join('; ') : '' }));
  const cols = [
    { key: 'date', header: 'Date', width: 13 }, { key: 'time', header: 'Time', width: 11 },
    { key: 'username', header: 'User', width: 16 }, { key: 'action', header: 'Action', width: 20 },
    { key: 'target', header: 'Target', width: 30 }, { key: 'details_text', header: 'Details', width: 60 },
  ];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="audit_log_${localDate()}.xlsx"`);
  res.send(buildXlsx([{ name: 'Audit Log', columns: cols, rows }]));
});

/* ============ تصدير التقارير (بالإنجليزية) ============ */
const EXCUSE_LABELS = { medical: 'Medical', personal: 'Personal', late: 'Late arrival', early_leave: 'Early leave', absence: 'Absence', other: 'Other' };
const STATUS_LABELS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

app.get('/api/hr/export', requireHR, (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const q = clean(req.query.q, 50);
  const movements = getMovements({ from, to, q });
  const daily = dailySummary(movements).reverse();

  const movCols = [
    { key: 'emp_no', header: 'Employee No', width: 14 }, { key: 'name', header: 'Name', width: 26 },
    { key: 'department', header: 'Department', width: 18 }, { key: 'work_date', header: 'Date', width: 13 },
    { key: 'time', header: 'Time', width: 12 }, { key: 'type_label', header: 'Action', width: 12 },
    { key: 'source_label', header: 'Source', width: 12 }, { key: 'site_name', header: 'Location', width: 20 },
    { key: 'distance_m', header: 'Distance (m)', width: 13 }, { key: 'map', header: 'Coordinates', width: 22 },
    { key: 'note', header: 'Note', width: 22 },
  ];
  const movRows = movements.reverse().map((m) => ({ ...m,
    type_label: m.type === 'in' ? 'Check-in' : 'Check-out', source_label: m.source === 'hr' ? 'HR (manual)' : 'Employee',
    distance_m: m.distance ?? '', map: m.lat != null ? `${m.lat}, ${m.lng}` : '' }));

  const dayCols = [
    { key: 'work_date', header: 'Date', width: 13 }, { key: 'emp_no', header: 'Employee No', width: 14 },
    { key: 'name', header: 'Name', width: 26 }, { key: 'department', header: 'Department', width: 18 },
    { key: 'first_in_time', header: 'First In', width: 12 }, { key: 'last_out_time', header: 'Last Out', width: 12 },
    { key: 'hours', header: 'Worked (h:mm)', width: 14 }, { key: 'hours_dec', header: 'Worked (hours)', width: 14 },
    { key: 'late_minutes', header: 'Late (min)', width: 11 }, { key: 'early_minutes', header: 'Early Leave (min)', width: 16 },
    { key: 'excuse_label', header: 'Approved Excuse', width: 16 }, { key: 'holiday', header: 'Public Holiday', width: 18 },
    { key: 'status_label', header: 'Status', width: 13 },
  ];
  const dayRows = daily.map((s) => ({ ...s,
    hours_dec: Math.round((s.minutes / 60) * 100) / 100,
    late_minutes: s.late_minutes || '', early_minutes: s.early_minutes || '',
    excuse_label: EXCUSE_LABELS[s.excuse_type] || '',
    status_label: s.status === 'in' ? 'Still in' : 'Checked out' }));

  const perCols = [
    { key: 'emp_no', header: 'Employee No', width: 14 }, { key: 'name', header: 'Name', width: 26 },
    { key: 'department', header: 'Department', width: 18 }, { key: 'workdays', header: 'Working Days', width: 13 },
    { key: 'present', header: 'Present', width: 10 }, { key: 'absent', header: 'Absent (no excuse)', width: 18 },
    { key: 'excused', header: 'Excused Absence', width: 16 }, { key: 'holidays', header: 'Public Holidays', width: 15 },
    { key: 'late_count', header: 'Late Days', width: 11 },
    { key: 'late_minutes', header: 'Late (min)', width: 11 }, { key: 'early_count', header: 'Early Leaves', width: 13 },
    { key: 'early_minutes', header: 'Early Leave (min)', width: 16 }, { key: 'hours', header: 'Total Worked (h:mm)', width: 18 },
  ];
  const perRows = periodSummary(from, to, { q });

  const excCols = [
    { key: 'emp_no', header: 'Employee No', width: 14 }, { key: 'name', header: 'Name', width: 26 },
    { key: 'type_label', header: 'Type', width: 14 }, { key: 'date_from', header: 'From', width: 13 },
    { key: 'date_to', header: 'To', width: 13 }, { key: 'reason', header: 'Reason', width: 32 },
    { key: 'status_label', header: 'Status', width: 12 }, { key: 'hr_note', header: 'HR Note', width: 26 },
    { key: 'decided_by', header: 'Decided By', width: 13 }, { key: 'submitted', header: 'Submitted By', width: 13 },
  ];
  const excRows = db.prepare(`SELECT x.*, e.emp_no, e.name FROM excuses x JOIN employees e ON e.id = x.employee_id
      WHERE x.date_to >= ? AND x.date_from <= ? ORDER BY x.date_from`).all(from, to)
    .map((x) => ({ ...x, type_label: EXCUSE_LABELS[x.type] || x.type, status_label: STATUS_LABELS[x.status],
      submitted: x.submitted_by === 'hr' ? 'HR' : 'Employee' }));

  const holCols = [
    { key: 'name', header: 'Holiday', width: 28 }, { key: 'date_from', header: 'From', width: 13 },
    { key: 'date_to', header: 'To', width: 13 }, { key: 'days', header: 'Days', width: 8 },
  ];
  const holRows = holidayIndex(from, to).list.map((h) => ({ ...h,
    days: Math.round((new Date(h.date_to) - new Date(h.date_from)) / 86400000) + 1 }));

  const base = `attendance_${from}_to_${to}`;
  if (req.query.format === 'csv') {
    const views = { summary: [dayCols, dayRows], period: [perCols, perRows], excuses: [excCols, excRows], movements: [movCols, movRows], holidays: [holCols, holRows] };
    const view = views[req.query.view] ? req.query.view : 'movements';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}_${view}.csv"`);
    return res.send(toCsv(...views[view]));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  res.send(buildXlsx([
    { name: 'Employee Summary', columns: perCols, rows: perRows },
    { name: 'Daily Summary', columns: dayCols, rows: dayRows },
    { name: 'Movements', columns: movCols, rows: movRows },
    { name: 'Excuses', columns: excCols, rows: excRows },
    { name: 'Public Holidays', columns: holCols, rows: holRows },
  ]));
});

/* ============ الصفحات ============ */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/hr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'hr.html')));
app.use('/api', (req, res) => fail(res, 404, 'not_found'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'file_too_large');
  console.error(err);
  fail(res, 500, 'server_error');
});

startScheduler();
app.listen(PORT, () => console.log(`HR Attendance running on port ${PORT} (timezone: ${TZ})`));

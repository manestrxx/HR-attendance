// lib/db.js — قاعدة البيانات (SQLite المدمجة في Node.js)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'attendance.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS employees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_no      TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    department  TEXT DEFAULT '',
    job_title   TEXT DEFAULT '',
    pin_hash    TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('in','out')),
    ts           TEXT NOT NULL,
    work_date    TEXT NOT NULL,
    source       TEXT DEFAULT 'self',
    ip           TEXT DEFAULT '',
    note         TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_att_emp_ts ON attendance(employee_id, ts);
  CREATE INDEX IF NOT EXISTS idx_att_date   ON attendance(work_date);

  CREATE TABLE IF NOT EXISTS hr_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS excuses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    date_from       TEXT NOT NULL,
    date_to         TEXT NOT NULL,
    reason          TEXT DEFAULT '',
    attachment      BLOB,
    attachment_name TEXT DEFAULT '',
    attachment_type TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    hr_note         TEXT DEFAULT '',
    submitted_by    TEXT NOT NULL DEFAULT 'employee',
    decided_by      TEXT DEFAULT '',
    decided_at      TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_exc_emp ON excuses(employee_id, date_from);

  CREATE TABLE IF NOT EXISTS reminders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    title              TEXT NOT NULL,
    category           TEXT DEFAULT 'other',
    details            TEXT DEFAULT '',
    recipients         TEXT NOT NULL,
    due_date           TEXT NOT NULL,
    repeat             TEXT NOT NULL DEFAULT 'once',
    notify_before_days INTEGER NOT NULL DEFAULT 0,
    active             INTEGER NOT NULL DEFAULT 1,
    last_sent_for      TEXT DEFAULT '',
    last_sent_at       TEXT DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS reminder_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
    title       TEXT DEFAULT '',
    recipients  TEXT DEFAULT '',
    status      TEXT NOT NULL,
    message     TEXT DEFAULT '',
    sent_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    radius     INTEGER NOT NULL DEFAULT 150,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS employee_sites (
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (employee_id, site_id)
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    date_from  TEXT NOT NULL,
    date_to    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    user_id   INTEGER,
    username  TEXT NOT NULL,
    action    TEXT NOT NULL,
    target    TEXT DEFAULT '',
    details   TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

// إضافة أعمدة جديدة للجداول القديمة دون فقدان البيانات
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('hr_users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
addColumn('hr_users', 'active', 'INTEGER NOT NULL DEFAULT 1');
addColumn('hr_users', 'created_at', "TEXT NOT NULL DEFAULT ''");
addColumn('employees', 'geo_mode', "TEXT NOT NULL DEFAULT 'any'"); // any | assigned | exempt
addColumn('attendance', 'lat', 'REAL');
addColumn('attendance', 'lng', 'REAL');
addColumn('attendance', 'accuracy', 'REAL');
addColumn('attendance', 'distance', 'REAL');
addColumn('attendance', 'site_id', 'INTEGER');
addColumn('attendance', 'site_name', "TEXT DEFAULT ''");

// الإعدادات الافتراضية
const DEFAULTS = {
  company_name: 'HR Attendance',
  work_start: '07:30',
  work_end: '15:30',
  grace_minutes: '10',
  weekend: '5,6', // الجمعة والسبت (0 = الأحد)
  mail_from: '',
  resend_api_key: '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? null);
}

function workSettings() {
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  return {
    company_name: getSetting('company_name'),
    work_start: getSetting('work_start'),
    work_end: getSetting('work_end'),
    start_min: toMin(getSetting('work_start')),
    end_min: toMin(getSetting('work_end')),
    grace: Math.max(0, parseInt(getSetting('grace_minutes'), 10) || 0),
    weekend: String(getSetting('weekend')).split(',').filter((x) => x !== '').map(Number),
  };
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

// مفتاح توقيع الجلسات: من متغير البيئة، وإلا يُولَّد مرة واحدة ويُحفظ
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}

module.exports = { db, DB_PATH, getSetting, setSetting, sessionSecret, workSettings };

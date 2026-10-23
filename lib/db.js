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

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
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

module.exports = { db, DB_PATH, getSetting, setSetting, sessionSecret };

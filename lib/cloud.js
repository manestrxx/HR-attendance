// lib/cloud.js — حفظ دائم للبيانات في Turso (قاعدة SQLite سحابية مجانية)
//
// الفكرة: النظام يعمل على ملف SQLite محلي سريع كما هو، وكل عملية كتابة
// (إضافة/تعديل/حذف) تُنسخ فورًا إلى Turso. وعند كل تشغيل للخادم تُسترجع
// كل البيانات من Turso، فلا تضيع حتى لو مسح Render الملفات.
const fs = require('fs');

const RAW_URL = process.env.TURSO_DATABASE_URL || '';
const TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const enabled = !!(RAW_URL && TOKEN);
const BASE = RAW_URL.trim().replace(/^(libsql|turso|wss|ws):\/\//i, 'https://').replace(/\/+$/, '');

const status = {
  mode: enabled ? 'turso' : 'local',
  restored_rows: 0,
  pending: 0,
  last_sync: '',
  last_error: '',
  failed_statements: 0,
};

/* ---------- التحويل بين قيم JavaScript وصيغة Turso ---------- */
function encode(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { type: 'integer', value: String(v) };
    // الأعداد العشرية تُرسل كنص، وعمود REAL يحوّلها تلقائيًا إلى رقم
    return { type: 'text', value: String(v) };
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}
function decode(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  if (v.type === 'blob') return Buffer.from(v.base64 || '', 'base64');
  return v.value;
}

/* ---------- إرسال مجموعة أوامر إلى Turso ---------- */
async function pipeline(stmts) {
  const body = {
    requests: [
      ...stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(encode) } })),
      { type: 'close' },
    ],
  };
  const res = await fetch(BASE + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Turso HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.http = res.status;
    throw err;
  }
  const data = await res.json();
  return stmts.map((_, i) => {
    const r = data.results?.[i];
    if (!r) return { ok: false, error: 'no result' };
    if (r.type === 'error') return { ok: false, error: r.error?.message || 'error' };
    const result = r.response?.result || {};
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((row) => Object.fromEntries(row.map((v, j) => [cols[j], decode(v)])));
    return { ok: true, rows, cols };
  });
}

async function query(sql, args = []) {
  const [r] = await pipeline([{ sql, args }]);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

/* ---------- طابور النسخ إلى Turso ---------- */
const queue = [];
let flushing = false;
let backoff = 1000;

function enqueue(sql, args) {
  queue.push({ sql, args: args.map((a) => (a instanceof Uint8Array && !Buffer.isBuffer(a) ? Buffer.from(a) : a)) });
  status.pending = queue.length;
  flush();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 50);
      let results;
      try {
        results = await pipeline(batch);
      } catch (e) {
        // مشكلة اتصال: نعيد المحاولة لاحقًا دون فقدان أي أمر
        status.last_error = e.message;
        console.error('[cloud] sync failed, will retry:', e.message);
        setTimeout(() => flush(), backoff);
        backoff = Math.min(backoff * 2, 30000);
        return;
      }
      backoff = 1000;
      results.forEach((r, i) => {
        if (!r.ok) {
          status.failed_statements++;
          status.last_error = r.error;
          console.error('[cloud] statement failed:', r.error, '|', batch[i].sql.slice(0, 120));
        }
      });
      queue.splice(0, batch.length);
      status.pending = queue.length;
      status.last_sync = new Date().toISOString();
    }
  } finally {
    flushing = false;
  }
}

// انتظار انتهاء النسخ (عند إيقاف الخادم)
async function drain(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (queue.length && Date.now() < end) {
    await flush();
    if (queue.length) await new Promise((r) => setTimeout(r, 500));
  }
}

/* ---------- ربط قاعدة البيانات المحلية بالنسخ التلقائي ---------- */
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

function attach(db) {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (!WRITE_RE.test(sql)) return stmt;
    const originalRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      const result = originalRun(...args);
      if (Number(result.changes) > 0) enqueue(sql, args);
      return result;
    };
    return stmt;
  };
}

/* ---------- مزامنة الجداول والاسترجاع عند التشغيل ---------- */
const TABLE_ORDER = ['settings', 'hr_users', 'employees', 'sites', 'employee_sites', 'holidays', 'attendance',
  'excuses', 'reminders', 'reminder_logs', 'audit_log'];

async function syncSchema(db) {
  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`).all();
  const ddl = objects.map((o) => ({
    sql: o.sql.replace(/^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s+(?!IF\s+NOT\s+EXISTS)/i, (m, kind) => `CREATE ${kind} IF NOT EXISTS `),
  }));
  const results = await pipeline(ddl);
  results.forEach((r, i) => { if (!r.ok) throw new Error(`schema: ${r.error} (${ddl[i].sql.slice(0, 80)})`); });

  // إضافة الأعمدة الجديدة التي قد لا تكون موجودة في Turso
  for (const t of objects.filter((o) => o.type === 'table')) {
    const remoteCols = new Set((await query(`PRAGMA table_info(${t.name})`)).map((c) => c.name));
    for (const c of db.prepare(`PRAGMA table_info(${t.name})`).all()) {
      if (remoteCols.has(c.name)) continue;
      let def = `${c.name} ${c.type || ''}`;
      if (c.dflt_value != null && !/\(/.test(c.dflt_value)) def += ` DEFAULT ${c.dflt_value}`;
      if (c.notnull && c.dflt_value != null && !/\(/.test(c.dflt_value)) def += ' NOT NULL';
      await query(`ALTER TABLE ${t.name} ADD COLUMN ${def}`);
      console.log(`[cloud] added column ${t.name}.${c.name}`);
    }
  }
}

async function restore(db) {
  const localTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const tables = [...TABLE_ORDER.filter((t) => localTables.includes(t)), ...localTables.filter((t) => !TABLE_ORDER.includes(t))];
  db.exec('PRAGMA foreign_keys = OFF');
  let total = 0;
  for (const t of tables) {
    const localCols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    let lastRowid = 0;
    for (;;) {
      const rows = await query(`SELECT rowid AS __rowid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT 500`, [lastRowid]);
      if (!rows.length) break;
      for (const row of rows) {
        lastRowid = row.__rowid;
        const cols = Object.keys(row).filter((c) => localCols.has(c));
        db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(...cols.map((c) => row[c]));
        total++;
      }
      if (rows.length < 500) break;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  status.restored_rows = total;
  return total;
}

/**
 * يُستدعى قبل تشغيل التطبيق: يحذف الملف المحلي القديم، ويجهّز الجداول في Turso،
 * ويسترجع كل البيانات، ثم يفعّل النسخ التلقائي.
 */
async function prepare() {
  if (!enabled) {
    console.warn('[cloud] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set: data is stored locally only and may be lost on restart');
    return;
  }
  const dbPath = process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'attendance.db');
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  const { db } = require('./db');

  for (let attempt = 1; ; attempt++) {
    try {
      await syncSchema(db);
      const n = await restore(db);
      console.log(`[cloud] connected to Turso, restored ${n} rows`);
      break;
    } catch (e) {
      status.last_error = e.message;
      console.error(`[cloud] startup attempt ${attempt} failed:`, e.message);
      if (attempt >= 8) {
        // لا نشغّل النظام بقاعدة فارغة، حتى لا تختلط البيانات
        console.error('[cloud] could not reach Turso, exiting so Render restarts the service');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 15000)));
    }
  }
  attach(db);
  status.last_sync = new Date().toISOString();

  // عند إيقاف Render للخادم: ننهي النسخ المعلّق أولًا
  const shutdown = async (sig) => {
    console.log(`[cloud] ${sig}: flushing ${queue.length} pending writes`);
    await drain(20000);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { enabled, status, prepare, drain };

// lib/report.js — حساب ساعات العمل وملخص الأيام
const { db } = require('./db');
const { localTime, fmtMinutes } = require('./time');

// جلب الحركات في فترة معيّنة
function getMovements({ from, to, employeeId, q, limit } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('a.work_date >= ?'); params.push(from); }
  if (to) { where.push('a.work_date <= ?'); params.push(to); }
  if (employeeId) { where.push('a.employee_id = ?'); params.push(employeeId); }
  if (q) {
    where.push('(e.emp_no LIKE ? OR e.name LIKE ? OR e.department LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  let sql = `SELECT a.id, a.employee_id, a.type, a.ts, a.work_date, a.source, a.note,
                    e.emp_no, e.name, e.department, e.job_title
             FROM attendance a JOIN employees e ON e.id = a.employee_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY a.ts DESC`;
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  return db.prepare(sql).all(...params).map((r) => ({ ...r, time: localTime(r.ts) }));
}

/**
 * ملخص يومي لكل موظف: أول دخول، آخر خروج، مجموع الدقائق، والحالة.
 * يقرن كل "دخول" بأول "خروج" يليه.
 */
function dailySummary(movements, now = new Date()) {
  const groups = new Map();
  const sorted = [...movements].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const m of sorted) {
    const key = `${m.employee_id}|${m.work_date}`;
    if (!groups.has(key)) {
      groups.set(key, {
        employee_id: m.employee_id, emp_no: m.emp_no, name: m.name, department: m.department,
        work_date: m.work_date, first_in: null, last_out: null, minutes: 0,
        sessions: 0, open_since: null, events: 0,
      });
    }
    const g = groups.get(key);
    g.events++;
    if (m.type === 'in') {
      if (!g.first_in) g.first_in = m.ts;
      if (!g.open_since) g.open_since = m.ts;
    } else {
      g.last_out = m.ts;
      if (g.open_since) {
        g.minutes += (new Date(m.ts) - new Date(g.open_since)) / 60000;
        g.sessions++;
        g.open_since = null;
      }
    }
  }
  return [...groups.values()].map((g) => {
    let minutes = g.minutes;
    // الموظف ما زال داخل العمل: نحسب حتى الآن (بحد أقصى 16 ساعة)
    if (g.open_since) {
      const live = (now - new Date(g.open_since)) / 60000;
      if (live > 0 && live < 16 * 60) minutes += live;
    }
    return {
      ...g,
      status: g.open_since ? 'in' : 'out',
      minutes: Math.round(minutes),
      hours: fmtMinutes(minutes),
      first_in_time: g.first_in ? localTime(g.first_in) : '',
      last_out_time: g.last_out ? localTime(g.last_out) : '',
    };
  }).sort((a, b) => b.work_date.localeCompare(a.work_date) || a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));
}

module.exports = { getMovements, dailySummary };

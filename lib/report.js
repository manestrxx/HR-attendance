// lib/report.js — حساب ساعات العمل والتأخير والغياب
const { db, workSettings } = require('./db');
const { localTime, localDate, localMinutes, fmtMinutes, weekday, daysBetween } = require('./time');

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

// فهرس الأعذار المقبولة في فترة: find(employeeId, date) يعيد العذر إن وُجد
function excuseIndex(from, to) {
  const rows = db.prepare(`SELECT id, employee_id, type, date_from, date_to FROM excuses
    WHERE status = 'approved' AND date_to >= ? AND date_from <= ?`).all(from, to);
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }
  return {
    find(empId, date) {
      return (byEmp.get(empId) || []).find((e) => e.date_from <= date && e.date_to >= date) || null;
    },
  };
}

/**
 * ملخص يومي لكل موظف: أول دخول، آخر خروج، الساعات، التأخير، الخروج المبكر.
 * يقرن كل "دخول" بأول "خروج" يليه.
 */
function dailySummary(movements, { now = new Date(), settings = workSettings(), excuses } = {}) {
  const groups = new Map();
  const sorted = [...movements].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const m of sorted) {
    const key = `${m.employee_id}|${m.work_date}`;
    if (!groups.has(key)) {
      groups.set(key, {
        employee_id: m.employee_id, emp_no: m.emp_no, name: m.name, department: m.department,
        work_date: m.work_date, first_in: null, last_out: null, minutes: 0, open_since: null,
      });
    }
    const g = groups.get(key);
    if (m.type === 'in') {
      if (!g.first_in) g.first_in = m.ts;
      if (!g.open_since) g.open_since = m.ts;
    } else {
      g.last_out = m.ts;
      if (g.open_since) {
        g.minutes += (new Date(m.ts) - new Date(g.open_since)) / 60000;
        g.open_since = null;
      }
    }
  }
  const dates = [...groups.values()].map((g) => g.work_date).sort();
  const exIdx = excuses || (dates.length ? excuseIndex(dates[0], dates[dates.length - 1]) : { find: () => null });

  return [...groups.values()].map((g) => {
    let minutes = g.minutes;
    if (g.open_since) {
      const live = (now - new Date(g.open_since)) / 60000;
      if (live > 0 && live < 16 * 60) minutes += live;
    }
    const status = g.open_since ? 'in' : 'out';
    const isWorkday = !settings.weekend.includes(weekday(g.work_date));

    let late = 0;
    if (g.first_in && isWorkday && localDate(g.first_in) === g.work_date) {
      const diff = localMinutes(g.first_in) - settings.start_min;
      if (diff > settings.grace) late = diff;
    }
    let early = 0;
    if (status === 'out' && g.last_out && isWorkday && localDate(g.last_out) === g.work_date) {
      const diff = settings.end_min - localMinutes(g.last_out);
      if (diff > 0) early = diff;
    }
    const excuse = exIdx.find(g.employee_id, g.work_date);
    return {
      ...g, status,
      minutes: Math.round(minutes),
      hours: fmtMinutes(minutes),
      first_in_time: g.first_in ? localTime(g.first_in) : '',
      last_out_time: g.last_out ? localTime(g.last_out) : '',
      late_minutes: late,
      early_minutes: early,
      excuse_type: excuse ? excuse.type : '',
    };
  }).sort((a, b) => b.work_date.localeCompare(a.work_date) || a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));
}

/**
 * ملخص شهري/لفترة لكل موظف: أيام الحضور، التأخير، الغياب بعذر وبدون عذر، الساعات.
 */
function periodSummary(from, to, { q } = {}) {
  const settings = workSettings();
  const today = localDate();
  const excuses = excuseIndex(from, to);
  const summary = dailySummary(getMovements({ from, to, q }), { settings, excuses });
  const byEmp = new Map();
  for (const s of summary) {
    if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, new Map());
    byEmp.get(s.employee_id).set(s.work_date, s);
  }
  let emps = db.prepare('SELECT id, emp_no, name, department, active, created_at FROM employees').all();
  if (q) {
    const ql = q.toLowerCase();
    emps = emps.filter((e) => `${e.emp_no} ${e.name} ${e.department}`.toLowerCase().includes(ql));
  }
  const workdays = daysBetween(from, to < today ? to : today).filter((d) => !settings.weekend.includes(weekday(d)));

  return emps.map((e) => {
    const days = byEmp.get(e.id) || new Map();
    if (!e.active && days.size === 0) return null;
    // نبدأ العدّ من تاريخ إضافة الموظف، أو من أول حضور مسجّل له إن كان أقدم
    const firstSeen = [...days.keys()].sort()[0];
    let joined = localDate(e.created_at);
    if (firstSeen && firstSeen < joined) joined = firstSeen;
    const r = {
      emp_no: e.emp_no, name: e.name, department: e.department,
      workdays: 0, present: days.size, late_count: 0, late_minutes: 0, early_count: 0, early_minutes: 0,
      absent: 0, excused: 0, minutes: 0,
    };
    for (const s of days.values()) {
      r.minutes += s.minutes;
      if (s.late_minutes && !s.excuse_type) { r.late_count++; r.late_minutes += s.late_minutes; }
      if (s.early_minutes && !s.excuse_type) { r.early_count++; r.early_minutes += s.early_minutes; }
    }
    for (const d of workdays) {
      if (d < joined) continue;
      r.workdays++;
      if (days.has(d)) continue;
      if (excuses.find(e.id, d)) r.excused++; else r.absent++;
    }
    r.hours = fmtMinutes(r.minutes);
    return r;
  }).filter(Boolean).sort((a, b) => a.emp_no.localeCompare(b.emp_no, undefined, { numeric: true }));
}

module.exports = { getMovements, dailySummary, excuseIndex, periodSummary };

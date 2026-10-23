// lib/reminders.js — جدولة التذكيرات وإرسالها بالإيميل
const { db, getSetting } = require('./db');
const { localDate, localMinutes, addDays, addMonths } = require('./time');
const { sendMail, isConfigured, parseEmails, reminderEmail } = require('./mailer');

const REPEATS = {
  once: { label: 'One time', next: null },
  weekly: { label: 'Every week', next: (d) => addDays(d, 7) },
  monthly: { label: 'Every month', next: (d) => addMonths(d, 1) },
  quarterly: { label: 'Every 3 months', next: (d) => addMonths(d, 3) },
  semiannual: { label: 'Every 6 months', next: (d) => addMonths(d, 6) },
  yearly: { label: 'Every year', next: (d) => addMonths(d, 12) },
  biennial: { label: 'Every 2 years', next: (d) => addMonths(d, 24) },
};
const SEND_FROM_MINUTE = 8 * 60; // لا نرسل قبل 8:00 صباحًا بتوقيت الشركة

const daysUntil = (from, to) => Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000);

function logSend(reminder, status, message) {
  db.prepare('INSERT INTO reminder_logs(reminder_id, title, recipients, status, message) VALUES (?,?,?,?,?)')
    .run(reminder.id ?? null, reminder.title, reminder.recipients, status, message || '');
}

async function sendReminder(reminder, { test = false } = {}) {
  const today = localDate();
  const { subject, html, text } = reminderEmail({
    company: getSetting('company_name'),
    title: reminder.title,
    details: reminder.details,
    dueDate: reminder.due_date,
    repeatLabel: REPEATS[reminder.repeat]?.label || reminder.repeat,
    daysLeft: daysUntil(today, reminder.due_date),
  });
  const result = await sendMail({ to: parseEmails(reminder.recipients), subject: (test ? '[TEST] ' : '') + subject, html, text });
  logSend(reminder, result.ok ? (test ? 'test' : 'sent') : 'failed', result.ok ? '' : (result.detail || result.error));
  return result;
}

let running = false;
async function runDueReminders(now = new Date()) {
  if (running || !isConfigured()) return;
  running = true;
  try {
    const today = localDate(now);
    if (localMinutes(now) < SEND_FROM_MINUTE) return;
    const list = db.prepare('SELECT * FROM reminders WHERE active = 1').all();
    for (const r of list) {
      const rep = REPEATS[r.repeat];
      // بعد مرور موعد تذكير متكرر (أُرسل له، أو فات بأكثر من 3 أيام) ننتقل للموعد التالي
      if (rep && rep.next && today > r.due_date && (r.last_sent_for === r.due_date || today > addDays(r.due_date, 3))) {
        let next = rep.next(r.due_date);
        while (next < today) next = rep.next(next);
        db.prepare('UPDATE reminders SET due_date=? WHERE id=?').run(next, r.id);
        r.due_date = next;
      }
      const sendOn = addDays(r.due_date, -Math.max(0, r.notify_before_days));
      if (today < sendOn || r.last_sent_for === r.due_date) continue;
      const result = await sendReminder(r);
      if (!result.ok) continue; // نعيد المحاولة في الدورة التالية
      db.prepare('UPDATE reminders SET last_sent_for=?, last_sent_at=?, active=? WHERE id=?')
        .run(r.due_date, now.toISOString(), rep && rep.next ? 1 : 0, r.id);
    }
  } catch (e) {
    console.error('[reminders]', e);
  } finally {
    running = false;
  }
}

function startScheduler() {
  setTimeout(() => runDueReminders(), 15 * 1000).unref();
  setInterval(() => runDueReminders(), 10 * 60 * 1000).unref();
}

module.exports = { REPEATS, sendReminder, runDueReminders, startScheduler };

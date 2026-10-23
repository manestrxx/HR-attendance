// lib/mailer.js — إرسال الإيميلات عبر خدمة Resend (تعمل على خطة Render المجانية)
const { getSetting } = require('./db');

function mailConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY || getSetting('resend_api_key') || '',
    from: process.env.MAIL_FROM || getSetting('mail_from') || 'HR Reminders <onboarding@resend.dev>',
  };
}

const isConfigured = () => !!mailConfig().apiKey;

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function parseEmails(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
const validEmails = (list) => list.length > 0 && list.length <= 50 && list.every((e) => EMAIL_RE.test(e));

async function sendMail({ to, subject, html, text }) {
  const { apiKey, from } = mailConfig();
  if (!apiKey) return { ok: false, error: 'email_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'email_failed', detail: data.message || `HTTP ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: 'email_failed', detail: e.message };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// قالب الإيميل (عربي + إنجليزي)
function reminderEmail({ company, title, details, dueDate, repeatLabel, daysLeft }) {
  const when = daysLeft > 0 ? `in ${daysLeft} day${daysLeft > 1 ? 's' : ''}` : daysLeft === 0 ? 'today' : 'overdue';
  const whenAr = daysLeft > 0 ? `بعد ${daysLeft} يوم` : daysLeft === 0 ? 'اليوم' : 'متأخر';
  const subject = `Reminder: ${title} — due ${dueDate}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #bfdbfe;border-radius:16px;overflow:hidden">
    <tr><td style="background:#1d4ed8;color:#ffffff;padding:18px 24px;font-size:16px;font-weight:bold">${esc(company)} · HR Reminder</td></tr>
    <tr><td style="padding:24px">
      <div style="font-size:20px;font-weight:bold;margin-bottom:6px">${esc(title)}</div>
      <div style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:4px 12px;font-size:13px">Due ${esc(dueDate)} · ${esc(when)}</div>
      ${details ? `<p style="font-size:15px;line-height:1.6;white-space:pre-line;margin:18px 0 0">${esc(details)}</p>` : ''}
      <p style="font-size:13px;color:#64748b;margin:18px 0 0">Repeats: ${esc(repeatLabel)}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <div dir="rtl" style="text-align:right;font-size:15px;line-height:1.7">
        <b>تذكير:</b> ${esc(title)}<br>الموعد: ${esc(dueDate)} (${esc(whenAr)})
      </div>
    </td></tr>
  </table>
  <p style="font-size:12px;color:#94a3b8">Sent automatically by the HR Attendance System</p>
  </td></tr></table></body></html>`;
  const text = `Reminder: ${title}\nDue: ${dueDate} (${when})\n\n${details || ''}\n\nتذكير: ${title} — الموعد ${dueDate}`;
  return { subject, html, text };
}

module.exports = { sendMail, isConfigured, parseEmails, validEmails, reminderEmail, mailConfig };

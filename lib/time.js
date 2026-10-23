// lib/time.js — التعامل مع الوقت حسب المنطقة الزمنية للشركة
const TZ = process.env.APP_TIMEZONE || 'Asia/Muscat';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const time24Fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const time12Fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });

// YYYY-MM-DD حسب توقيت الشركة
const localDate = (d = new Date()) => dateFmt.format(new Date(d));
// الوقت بنظام 12 ساعة: 8:05 AM
const localTime = (d = new Date()) => time12Fmt.format(new Date(d)).replace(/ /g, ' ');
// عدد الدقائق منذ منتصف الليل حسب توقيت الشركة
function localMinutes(d) {
  const [h, m] = time24Fmt.format(new Date(d)).split(':').map(Number);
  return h * 60 + m;
}
// تحويل "07:30" إلى "7:30 AM"
function hhmmTo12(s) {
  if (!s) return '';
  let [h, m] = s.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
// يوم الأسبوع لتاريخ (0 = الأحد)
const weekday = (dateStr) => new Date(dateStr + 'T12:00:00Z').getUTCDay();

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

// تحويل الدقائق إلى صيغة 7:45
function fmtMinutes(min) {
  if (!min || min < 0) return '0:00';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

// فرق التوقيت (بالدقائق) للمنطقة الزمنية عند لحظة معيّنة
function tzOffsetMinutes(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// تحويل تاريخ ووقت محلي (توقيت الشركة) إلى ISO بتوقيت UTC
function localToUtcIso(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = naive - tzOffsetMinutes(naive) * 60000;
  utc = naive - tzOffsetMinutes(utc) * 60000;
  return new Date(utc).toISOString();
}

module.exports = {
  TZ, localDate, localTime, localMinutes, hhmmTo12, isDate, isTime,
  addDays, addMonths, weekday, daysBetween, fmtMinutes, localToUtcIso,
};

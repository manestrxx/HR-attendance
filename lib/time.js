// lib/time.js — التعامل مع الوقت حسب المنطقة الزمنية للشركة
const TZ = process.env.APP_TIMEZONE || 'Asia/Muscat';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// YYYY-MM-DD حسب توقيت الشركة
const localDate = (d = new Date()) => dateFmt.format(new Date(d));
// HH:MM:SS حسب توقيت الشركة
const localTime = (d = new Date()) => timeFmt.format(new Date(d));

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// تحويل الدقائق إلى صيغة 7:45
function fmtMinutes(min) {
  if (!min) return '0:00';
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

const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);

module.exports = { TZ, localDate, localTime, isDate, isTime, addDays, fmtMinutes, localToUtcIso };

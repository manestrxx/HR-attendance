// lib/csv.js — إنشاء وقراءة ملفات CSV (تدعم العربية في Excel)
function toCsv(columns, rows) {
  const q = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => q(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => q(r[c.key])).join(','));
  // BOM يجعل Excel يعرض الحروف العربية بشكل صحيح
  return '﻿' + lines.join('\r\n');
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

module.exports = { toCsv, parseCsv };

// public/js/employee.js — منطق صفحة الموظف
(() => {
  let serverOffset = 0; // الفرق بين ساعة الخادم وساعة الجهاز
  let tz = 'Asia/Muscat';
  let today = new Date().toISOString().slice(0, 10);
  let view = 'punch';
  let clearTimer = null;

  const $ = (id) => document.getElementById(id);
  const form = $('main-form');
  const empInput = $('emp_no');
  const pinInput = $('pin');
  const remember = $('remember');
  const result = $('result');
  const myList = $('my-list');

  /* ---------- الساعة ---------- */
  async function syncTime() {
    const t0 = Date.now();
    const data = await api('/api/time');
    if (!data.ok) return;
    serverOffset = new Date(data.now).getTime() + (Date.now() - t0) / 2 - Date.now();
    tz = data.tz;
    today = data.date;
    if (data.company && data.company !== 'HR Attendance') $('company').textContent = data.company;
    if (!$('ex-from').value) { $('ex-from').value = today; $('ex-to').value = today; }
  }
  async function loadHours() {
    // أوقات الدوام تظهر للموظف للعلم فقط
    const data = await api('/api/work-hours');
    if (data.ok) $('work-hours').textContent = `${data.start} – ${data.end}`;
  }

  function tick() {
    const now = new Date(Date.now() + serverOffset);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
      .formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    $('clock').textContent = `${get('hour')}:${get('minute')}:${get('second')}`;
    $('ampm').textContent = get('dayPeriod');
    const locale = getLang() === 'ar' ? 'ar-OM-u-nu-latn' : 'en-GB';
    $('date').textContent = now.toLocaleDateString(locale, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ---------- الأقسام ---------- */
  function setView(v) {
    view = v;
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== v; });
    result.hidden = true;
    myList.hidden = true;
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  /* ---------- النتيجة ---------- */
  function showResult(html, kind) {
    const styles = {
      success: 'border-color:#bfeadb;background:#f0fbf6;color:#064e36',
      error: 'border-color:#f6cccc;background:#fff5f5;color:#8a1c1c',
    };
    result.className = 'mt-4 rounded-2xl border-2 p-5';
    result.style.cssText = styles[kind];
    result.innerHTML = html;
    result.hidden = false;
    clearTimeout(clearTimer);
    if (view === 'punch') clearTimer = setTimeout(() => { result.hidden = true; }, kind === 'success' ? 8000 : 6000);
  }
  const showError = (data) => {
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    showResult(`<p class="font-semibold">${escapeHtml(errorText(data))}</p>`, 'error');
  };

  /* ---------- الرقم المحفوظ ---------- */
  try {
    const saved = localStorage.getItem('emp_no');
    if (saved) { empInput.value = saved; remember.checked = true; }
  } catch {}
  function rememberEmp(empNo) {
    try {
      if (remember.checked) localStorage.setItem('emp_no', empNo); else localStorage.removeItem('emp_no');
    } catch {}
  }
  pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6); });

  $('ex-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('ex-file-name').textContent = f ? f.name : t('choose_attachment');
  });
  $('ex-from').addEventListener('change', () => { if ($('ex-to').value < $('ex-from').value) $('ex-to').value = $('ex-from').value; });

  /* ---------- الإرسال ---------- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.action || (view === 'punch' ? 'in' : view);
    const emp_no = empInput.value.trim();
    const pin = pinInput.value.trim();
    if (!emp_no || !pin) return showError({ error: 'missing_fields' });

    const buttons = form.querySelectorAll('button[type=submit]');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (action === 'in' || action === 'out') await punch(emp_no, pin, action);
      else if (action === 'excuse') await sendExcuse(emp_no, pin);
      else if (action === 'mine') await loadMine(emp_no, pin);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });

  async function punch(emp_no, pin, action) {
    const data = await api('/api/punch', { method: 'POST', body: { emp_no, pin, action } });
    pinInput.value = '';
    if (!data.ok) return showError(data);
    rememberEmp(emp_no);
    if (!remember.checked) empInput.value = '';
    if (navigator.vibrate) navigator.vibrate(80);
    const r = data.record;
    const isIn = r.type === 'in';
    const late = data.today && data.today.late_minutes && isIn ? `<span class="badge b-late mt-2">${escapeHtml(t('late_by', { m: fmtMins(data.today.late_minutes) }))}</span>` : '';
    showResult(`
      <div class="flex items-start gap-3">
        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-white" style="background:${isIn ? 'var(--green)' : 'var(--blue)'}">
          <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
        </div>
        <div class="min-w-0">
          <p class="text-sm opacity-80">${escapeHtml(t('hello'))} ${escapeHtml(r.name)}</p>
          <p class="text-lg font-bold">${escapeHtml(t(isIn ? 'success_in' : 'success_out'))}</p>
          <p class="mt-1 text-sm">${escapeHtml(t('at'))} <b class="tabular" dir="ltr">${escapeHtml(r.time)}</b></p>
          ${data.today && !isIn ? `<p class="mt-1 text-sm">${escapeHtml(t('worked_today'))}: <b class="tabular" dir="ltr">${escapeHtml(data.today.hours)}</b></p>` : ''}
          ${late}
        </div>
      </div>`, 'success');
  }

  async function sendExcuse(emp_no, pin) {
    let attachment = null;
    const file = $('ex-file').files[0];
    if (file) {
      if (file.size > 12 * 1024 * 1024) return showError({ error: 'file_too_large' });
      attachment = await readAttachment(file);
    }
    const data = await api('/api/excuses', {
      method: 'POST',
      body: { emp_no, pin, type: $('ex-type').value, date_from: $('ex-from').value, date_to: $('ex-to').value,
        reason: $('ex-reason').value, attachment },
    });
    if (!data.ok) return showError(data);
    rememberEmp(emp_no);
    pinInput.value = '';
    $('ex-reason').value = '';
    $('ex-file').value = '';
    $('ex-file-name').textContent = t('choose_attachment');
    showResult(`<p class="text-sm opacity-80">${escapeHtml(t('hello'))} ${escapeHtml(data.name)}</p>
      <p class="mt-0.5 font-bold">${escapeHtml(t('excuse_sent'))}</p>`, 'success');
  }

  async function loadMine(emp_no, pin) {
    const data = await api('/api/my/excuses', { method: 'POST', body: { emp_no, pin } });
    if (!data.ok) return showError(data);
    rememberEmp(emp_no);
    pinInput.value = '';
    result.hidden = true;
    myList.hidden = false;
    myList.innerHTML = data.excuses.length ? data.excuses.map((x) => `
      <li class="card p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="font-semibold">${escapeHtml(t('ex_' + x.type))}</span>
          <span class="badge b-${x.status}">${escapeHtml(t('st_' + x.status))}</span>
        </div>
        <p class="mt-1 text-sm muted tabular">${escapeHtml(fmtRange(x.date_from, x.date_to))}</p>
        ${x.hr_note ? `<p class="card-soft mt-3 px-3 py-2 text-sm"><b>${escapeHtml(t('hr_note'))}:</b> ${escapeHtml(x.hr_note)}</p>` : ''}
      </li>`).join('') : `<li class="card p-6 text-center text-sm muted">${escapeHtml(t('no_requests'))}</li>`;
  }

  document.addEventListener('langchange', () => { tick(); if (!$('ex-file').files[0]) $('ex-file-name').textContent = t('choose_attachment'); });
  syncTime().then(tick);
  loadHours();
  setInterval(tick, 1000);
  setInterval(syncTime, 5 * 60 * 1000);
})();

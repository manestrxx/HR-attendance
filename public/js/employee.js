// public/js/employee.js — منطق صفحة الموظف
(() => {
  let serverOffset = 0; // الفرق بين ساعة الخادم وساعة الجهاز
  let tz = 'Asia/Muscat';
  let clearTimer = null;

  const $ = (id) => document.getElementById(id);
  const form = $('punch-form');
  const empInput = $('emp_no');
  const pinInput = $('pin');
  const remember = $('remember');
  const result = $('result');

  // مزامنة الوقت مع الخادم حتى يظهر الوقت الرسمي وليس وقت الجوال
  async function syncTime() {
    const t0 = Date.now();
    const data = await api('/api/time');
    if (data.ok) {
      const rtt = Date.now() - t0;
      serverOffset = new Date(data.now).getTime() + rtt / 2 - Date.now();
      tz = data.tz;
    }
  }

  function tick() {
    const now = new Date(Date.now() + serverOffset);
    const locale = getLang() === 'ar' ? 'ar-OM-u-nu-latn' : 'en-GB';
    $('clock').textContent = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
    $('date').textContent = now.toLocaleDateString(locale, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function showResult(html, kind) {
    const styles = {
      success: 'border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-100',
      error: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100',
    };
    result.className = `mt-4 rounded-3xl border p-5 ${styles[kind]}`;
    result.innerHTML = html;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => result.classList.add('hidden'), kind === 'success' ? 8000 : 6000);
  }

  // الرقم الوظيفي المحفوظ
  try {
    const saved = localStorage.getItem('emp_no');
    if (saved) { empInput.value = saved; remember.checked = true; }
  } catch {}

  pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.action || 'in';
    const emp_no = empInput.value.trim();
    const pin = pinInput.value.trim();
    if (!emp_no || !pin) return showResult(escapeHtml(t('err_missing_fields')), 'error');

    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    const data = await api('/api/punch', { method: 'POST', body: { emp_no, pin, action } });
    buttons.forEach((b) => (b.disabled = false));
    pinInput.value = '';

    if (!data.ok) {
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return showResult(`<p class="font-semibold">${escapeHtml(errorText(data))}</p>`, 'error');
    }

    try {
      if (remember.checked) localStorage.setItem('emp_no', emp_no);
      else localStorage.removeItem('emp_no');
    } catch {}
    if (!remember.checked) empInput.value = '';
    if (navigator.vibrate) navigator.vibrate(80);

    const r = data.record;
    const isIn = r.type === 'in';
    showResult(`
      <div class="flex items-start gap-3">
        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-full ${isIn ? 'bg-teal-700' : 'bg-amber-500'} text-white">
          <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
        </div>
        <div class="min-w-0">
          <p class="text-sm opacity-80">${escapeHtml(t('hello'))} ${escapeHtml(r.name)}</p>
          <p class="text-lg font-semibold">${escapeHtml(t(isIn ? 'success_in' : 'success_out'))}</p>
          <p class="mt-1 text-sm">${escapeHtml(t('at'))} <span class="tabular font-semibold" dir="ltr">${escapeHtml(r.time)}</span></p>
          ${data.today ? `<p class="mt-1 text-sm">${escapeHtml(t('worked_today'))}: <span class="tabular font-semibold" dir="ltr">${escapeHtml(data.today.hours)}</span></p>` : ''}
        </div>
      </div>`, 'success');
  });

  document.addEventListener('langchange', tick);
  syncTime().then(tick);
  setInterval(tick, 1000);
  setInterval(syncTime, 5 * 60 * 1000);
})();

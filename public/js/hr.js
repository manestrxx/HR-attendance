// public/js/hr.js — منطق لوحة الموارد البشرية
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    tab: 'live', today: null, liveDate: null, overview: null, filter: 'all', search: '',
    employees: [], empSearch: '', records: null, stream: null, me: null,
  };

  /* ---------- أدوات ---------- */
  function toast(msg, kind = 'info') {
    const colors = { info: 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900', error: 'bg-rose-600 text-white', success: 'bg-teal-700 text-white' };
    const el = document.createElement('div');
    el.className = `pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm font-medium shadow-lg transition ${colors[kind]}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }
  async function call(url, opts) {
    const data = await api(url, opts);
    if (data.status === 401 && !url.endsWith('/login')) { showLogin(); }
    return data;
  }
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
  const badge = (status) => {
    const map = {
      in: 'bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
      out: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
      absent: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-200',
    };
    return `<span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${map[status]}">${escapeHtml(t('status_' + status))}</span>`;
  };
  const typeBadge = (type) => `<span class="rounded-full px-2 py-0.5 text-xs font-medium ${type === 'in'
    ? 'bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'}">${escapeHtml(t(type))}</span>`;
  const empty = () => `<p class="py-8 text-center text-sm text-stone-400">${escapeHtml(t('no_data'))}</p>`;

  /* ---------- الدخول والخروج ---------- */
  function showLogin() {
    if (state.stream) { state.stream.close(); state.stream = null; }
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    $('login-view').classList.add('flex');
  }
  async function showApp(me) {
    state.me = me;
    $('login-view').classList.add('hidden');
    $('login-view').classList.remove('flex');
    $('app-view').classList.remove('hidden');
    const time = await call('/api/time');
    state.today = time.date;
    state.liveDate = state.today;
    $('live-date').value = state.today;
    initRecordsForm();
    initExportForm();
    connectStream();
    setTab((location.hash || '#live').slice(1));
    if (me.must_change) openPassword(true);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = await call('/api/hr/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    if (!data.ok) {
      $('login-error').textContent = errorText(data);
      $('login-error').classList.remove('hidden');
      return;
    }
    $('login-error').classList.add('hidden');
    e.target.reset();
    showApp(data.user);
  });

  $('btn-logout').addEventListener('click', async () => {
    await call('/api/hr/logout', { method: 'POST' });
    showLogin();
  });

  /* ---------- كلمة المرور ---------- */
  function openPassword(must = false) {
    $('pw-must').classList.toggle('hidden', !must);
    $('pw-error').classList.add('hidden');
    $('pw-form').reset();
    $('pw-dialog').showModal();
  }
  $('btn-password').addEventListener('click', () => openPassword(false));
  $('pw-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const data = await call('/api/hr/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
    if (!data.ok) { $('pw-error').textContent = errorText(data); $('pw-error').classList.remove('hidden'); return; }
    $('pw-dialog').close();
    toast(t('saved'), 'success');
  });

  /* ---------- التبويبات ---------- */
  function setTab(tab) {
    if (!['live', 'records', 'employees', 'export'].includes(tab)) tab = 'live';
    state.tab = tab;
    history.replaceState(null, '', '#' + tab);
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
    document.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'live') loadOverview();
    if (tab === 'records') loadRecords();
    if (tab === 'employees') loadEmployees();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  /* ---------- مباشر ---------- */
  async function loadOverview() {
    const data = await call('/api/hr/overview?date=' + encodeURIComponent(state.liveDate || ''));
    if (!data.ok) return;
    state.overview = data;
    $('live-updated').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    renderOverview();
  }

  function renderOverview() {
    const o = state.overview;
    if (!o) return;
    $('stat-in').textContent = o.stats.in;
    $('stat-out').textContent = o.stats.out;
    $('stat-absent').textContent = o.stats.absent;
    $('stat-total').textContent = o.stats.total;

    const chips = ['all', 'in', 'out', 'absent'];
    $('live-chips').innerHTML = chips.map((c) => {
      const count = c === 'all' ? o.stats.total : o.stats[c];
      const on = state.filter === c;
      return `<button data-chip="${c}" class="rounded-full px-3 py-1.5 text-sm ${on ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300'}">
        ${escapeHtml(t(c === 'all' ? 'all' : 'status_' + c))} <span class="tabular opacity-70">${count}</span></button>`;
    }).join('');

    const q = state.search.toLowerCase();
    const list = o.employees.filter((e) => (state.filter === 'all' || e.status === state.filter)
      && (!q || `${e.name} ${e.emp_no} ${e.department}`.toLowerCase().includes(q)));
    $('live-list').innerHTML = list.length ? list.map((e) => `
      <li class="flex items-center gap-3 py-3">
        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-stone-100 text-sm font-semibold text-stone-600 dark:bg-stone-800 dark:text-stone-300">${escapeHtml(initials(e.name))}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">${escapeHtml(e.name)}</div>
          <div class="truncate text-xs text-stone-500"><span class="tabular" dir="ltr">#${escapeHtml(e.emp_no)}</span>${e.department ? ' · ' + escapeHtml(e.department) : ''}</div>
          ${e.first_in ? `<div class="mt-1 flex flex-wrap gap-x-3 text-xs text-stone-600 dark:text-stone-400">
            <span>${escapeHtml(t('first_in'))}: <b class="tabular" dir="ltr">${escapeHtml(e.first_in)}</b></span>
            ${e.last_out ? `<span>${escapeHtml(t('last_out'))}: <b class="tabular" dir="ltr">${escapeHtml(e.last_out)}</b></span>` : ''}
            <span>${escapeHtml(t('hours'))}: <b class="tabular" dir="ltr">${escapeHtml(e.hours)}</b></span></div>` : ''}
        </div>
        ${badge(e.status)}
      </li>`).join('') : empty();

    $('recent-list').innerHTML = o.recent.length ? o.recent.map((r) => `
      <li class="flex items-center gap-2 text-sm">
        <span class="h-2 w-2 shrink-0 rounded-full ${r.type === 'in' ? 'bg-teal-600' : 'bg-amber-500'}"></span>
        <span class="min-w-0 flex-1 truncate">${escapeHtml(r.name)}</span>
        <span class="text-xs text-stone-500">${escapeHtml(t(r.type))}</span>
        <span class="tabular text-xs font-medium" dir="ltr">${escapeHtml(r.time.slice(0, 5))}</span>
      </li>`).join('') : empty();
  }

  $('live-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (b) { state.filter = b.dataset.chip; renderOverview(); }
  });
  document.querySelectorAll('.stat').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderOverview(); }));
  $('live-search').addEventListener('input', (e) => { state.search = e.target.value; renderOverview(); });
  $('live-date').addEventListener('change', (e) => { state.liveDate = e.target.value || state.today; loadOverview(); });

  /* ---------- البث اللحظي ---------- */
  let reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (state.tab === 'live') loadOverview();
      if (state.tab === 'records') loadRecords();
      if (state.tab === 'employees') loadEmployees();
    }, 400);
  }
  function setLive(on) {
    const dot = $('live-dot');
    dot.classList.toggle('opacity-40', !on);
  }
  function connectStream() {
    if (state.stream) state.stream.close();
    const es = new EventSource('/api/hr/stream');
    state.stream = es;
    es.onopen = () => setLive(true);
    es.addEventListener('punch', (e) => {
      const r = JSON.parse(e.data);
      toast(t(r.type === 'in' ? 'new_punch_in' : 'new_punch_out', { name: r.name }), r.type === 'in' ? 'success' : 'info');
      scheduleReload();
    });
    es.addEventListener('refresh', scheduleReload);
    es.onerror = async () => {
      setLive(false);
      // إذا انتهت الجلسة نعيد شاشة الدخول
      const me = await api('/api/hr/me');
      if (me.status === 401) showLogin();
    };
  }
  setInterval(() => { if (state.tab === 'live' && !$('app-view').classList.contains('hidden')) loadOverview(); }, 60000);

  /* ---------- السجلات ---------- */
  function initRecordsForm() {
    const f = $('records-form');
    if (!f.from.value) { f.from.value = addDays(state.today, -6); f.to.value = state.today; }
    const m = $('manual-form');
    m.date.value = state.today;
  }

  async function loadRecords() {
    const f = $('records-form');
    const params = new URLSearchParams({ from: f.from.value, to: f.to.value, q: f.q.value, view: f.view.value });
    const data = await call('/api/hr/records?' + params);
    if (!data.ok) return;
    state.records = data;
    renderRecords();
  }

  function renderRecords() {
    const d = state.records;
    if (!d) return;
    $('records-count').textContent = t('rows_count', { n: d.rows.length });
    if (!d.rows.length) { $('records-out').innerHTML = empty(); return; }
    const th = (k) => `<th class="px-3 py-2 text-start font-medium">${escapeHtml(t(k))}</th>`;
    const td = (v, cls = '') => `<td class="px-3 py-2.5 ${cls}">${v}</td>`;

    if (d.view === 'summary') {
      $('records-out').innerHTML = `
        <ul class="divide-y divide-stone-100 md:hidden dark:divide-stone-800">${d.rows.map((r) => `
          <li class="py-3">
            <div class="flex items-center justify-between gap-2"><span class="truncate font-medium">${escapeHtml(r.name)}</span>${badge(r.status === 'in' ? 'in' : 'out')}</div>
            <div class="mt-1 flex flex-wrap gap-x-3 text-xs text-stone-500">
              <span class="tabular" dir="ltr">${escapeHtml(r.work_date)}</span><span class="tabular" dir="ltr">#${escapeHtml(r.emp_no)}</span>
              <span>${escapeHtml(t('first_in'))}: <b class="tabular" dir="ltr">${escapeHtml(r.first_in_time || '—')}</b></span>
              <span>${escapeHtml(t('last_out'))}: <b class="tabular" dir="ltr">${escapeHtml(r.last_out_time || '—')}</b></span>
              <span>${escapeHtml(t('hours'))}: <b class="tabular" dir="ltr">${escapeHtml(r.hours)}</b></span></div>
          </li>`).join('')}</ul>
        <table class="hidden w-full text-sm md:table">
          <thead class="bg-stone-50 text-stone-500 dark:bg-stone-800"><tr>${['date', 'emp_no', 'name', 'department', 'first_in', 'last_out', 'hours'].map(th).join('')}<th></th></tr></thead>
          <tbody class="divide-y divide-stone-100 dark:divide-stone-800">${d.rows.map((r) => `<tr>
            ${td(escapeHtml(r.work_date), 'tabular')}${td(escapeHtml(r.emp_no), 'tabular')}${td(escapeHtml(r.name), 'font-medium')}
            ${td(escapeHtml(r.department))}${td(escapeHtml(r.first_in_time || '—'), 'tabular')}${td(escapeHtml(r.last_out_time || '—'), 'tabular')}
            ${td(escapeHtml(r.hours), 'tabular font-semibold')}${td(badge(r.status === 'in' ? 'in' : 'out'))}</tr>`).join('')}</tbody>
        </table>`;
      return;
    }

    const del = (r) => `<button data-del-rec="${r.id}" class="rounded-lg px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">${escapeHtml(t('delete'))}</button>`;
    const src = (r) => (r.source === 'hr' ? `<span class="text-xs text-stone-400">${escapeHtml(t('source_hr'))}</span>` : '');
    $('records-out').innerHTML = `
      <ul class="divide-y divide-stone-100 md:hidden dark:divide-stone-800">${d.rows.map((r) => `
        <li class="flex items-center gap-3 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2"><span class="truncate font-medium">${escapeHtml(r.name)}</span>${typeBadge(r.type)}${src(r)}</div>
            <div class="mt-0.5 text-xs text-stone-500"><span class="tabular" dir="ltr">${escapeHtml(r.work_date)} · ${escapeHtml(r.time)}</span> · <span class="tabular" dir="ltr">#${escapeHtml(r.emp_no)}</span></div>
          </div>${del(r)}
        </li>`).join('')}</ul>
      <table class="hidden w-full text-sm md:table">
        <thead class="bg-stone-50 text-stone-500 dark:bg-stone-800"><tr>${['date', 'time', 'emp_no', 'name', 'department', 'type'].map(th).join('')}<th></th></tr></thead>
        <tbody class="divide-y divide-stone-100 dark:divide-stone-800">${d.rows.map((r) => `<tr>
          ${td(escapeHtml(r.work_date), 'tabular')}${td(escapeHtml(r.time), 'tabular')}${td(escapeHtml(r.emp_no), 'tabular')}
          ${td(escapeHtml(r.name), 'font-medium')}${td(escapeHtml(r.department))}${td(typeBadge(r.type) + ' ' + src(r))}${td(del(r), 'text-end')}</tr>`).join('')}</tbody>
      </table>`;
  }

  $('records-form').addEventListener('submit', (e) => { e.preventDefault(); loadRecords(); });
  $('records-out').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-rec]');
    if (!b || !confirm(t('confirm_delete_rec'))) return;
    const data = await call('/api/hr/records/' + b.dataset.delRec, { method: 'DELETE' });
    if (data.ok) { toast(t('deleted')); loadRecords(); } else toast(errorText(data), 'error');
  });
  $('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = await call('/api/hr/records', { method: 'POST', body: Object.fromEntries(f) });
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('saved'), 'success');
    e.target.emp_no.value = ''; e.target.note.value = '';
    loadRecords();
  });

  /* ---------- الموظفون ---------- */
  async function loadEmployees() {
    const data = await call('/api/hr/employees');
    if (!data.ok) return;
    state.employees = data.employees;
    renderEmployees();
  }

  function renderEmployees() {
    const q = state.empSearch.toLowerCase();
    const list = state.employees.filter((e) => !q || `${e.name} ${e.emp_no} ${e.department} ${e.job_title}`.toLowerCase().includes(q));
    $('emp-list').innerHTML = list.length ? list.map((e) => `
      <li class="flex flex-wrap items-center gap-3 py-3 ${e.active ? '' : 'opacity-60'}">
        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-stone-100 text-sm font-semibold text-stone-600 dark:bg-stone-800 dark:text-stone-300">${escapeHtml(initials(e.name))}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2"><span class="truncate font-medium">${escapeHtml(e.name)}</span>
            ${e.active ? '' : `<span class="rounded-full bg-stone-200 px-2 py-0.5 text-xs dark:bg-stone-700">${escapeHtml(t('inactive'))}</span>`}</div>
          <div class="truncate text-xs text-stone-500"><span class="tabular" dir="ltr">#${escapeHtml(e.emp_no)}</span>${e.department ? ' · ' + escapeHtml(e.department) : ''}${e.job_title ? ' · ' + escapeHtml(e.job_title) : ''}</div>
        </div>
        <div class="flex gap-1 text-xs">
          <button data-edit="${e.id}" class="rounded-lg border border-stone-300 px-2.5 py-1.5 dark:border-stone-700">${escapeHtml(t('edit'))}</button>
          <button data-toggle="${e.id}" class="rounded-lg border border-stone-300 px-2.5 py-1.5 dark:border-stone-700">${escapeHtml(t(e.active ? 'deactivate' : 'activate'))}</button>
          <button data-del-emp="${e.id}" class="rounded-lg px-2.5 py-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">${escapeHtml(t('delete'))}</button>
        </div>
      </li>`).join('') : empty();
  }

  $('emp-search').addEventListener('input', (e) => { state.empSearch = e.target.value; renderEmployees(); });

  $('emp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await call('/api/hr/employees', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('saved'), 'success');
    e.target.reset();
    loadEmployees();
  });

  $('emp-list').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const toggle = e.target.closest('[data-toggle]');
    const del = e.target.closest('[data-del-emp]');
    if (edit) {
      const emp = state.employees.find((x) => x.id === Number(edit.dataset.edit));
      const f = $('edit-form');
      f.id.value = emp.id; f.emp_no.value = emp.emp_no; f.name.value = emp.name;
      f.department.value = emp.department || ''; f.job_title.value = emp.job_title || ''; f.pin.value = '';
      $('edit-error').classList.add('hidden');
      $('edit-dialog').showModal();
    }
    if (toggle) {
      const emp = state.employees.find((x) => x.id === Number(toggle.dataset.toggle));
      const data = await call('/api/hr/employees/' + emp.id, { method: 'PUT', body: { active: !emp.active } });
      if (data.ok) loadEmployees(); else toast(errorText(data), 'error');
    }
    if (del && confirm(t('confirm_delete_emp'))) {
      const data = await call('/api/hr/employees/' + del.dataset.delEmp, { method: 'DELETE' });
      if (data.ok) { toast(t('deleted')); loadEmployees(); } else toast(errorText(data), 'error');
    }
  });

  $('edit-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { emp_no: f.emp_no, name: f.name, department: f.department, job_title: f.job_title };
    if (f.pin) body.pin = f.pin;
    const data = await call('/api/hr/employees/' + f.id, { method: 'PUT', body });
    if (!data.ok) { $('edit-error').textContent = errorText(data); $('edit-error').classList.remove('hidden'); return; }
    $('edit-dialog').close();
    toast(t('saved'), 'success');
    loadEmployees();
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $('import-result');
    out.className = 'mt-3 text-sm text-stone-500';
    out.textContent = t('loading');
    const buf = await file.arrayBuffer();
    const data = await call('/api/hr/employees/import', {
      method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' },
    });
    e.target.value = '';
    if (!data.ok) { out.className = 'mt-3 text-sm text-rose-600'; out.textContent = errorText(data); return; }
    out.className = 'mt-3 text-sm text-teal-700 dark:text-teal-300';
    const errs = data.errors.slice(0, 5).map((x) => `• ${x.row}${x.emp_no ? ' (' + x.emp_no + ')' : ''}: ${t('err_' + x.error)}`).join('\n');
    out.textContent = t('imported', { added: data.added, updated: data.updated, errors: data.errors.length }) + (errs ? '\n' + errs : '');
    out.style.whiteSpace = 'pre-line';
    loadEmployees();
  });

  /* ---------- التصدير ---------- */
  function initExportForm() {
    const f = $('export-form');
    if (!f.from.value) { f.from.value = state.today.slice(0, 8) + '01'; f.to.value = state.today; }
    f.lang.value = getLang();
  }
  $('quick-ranges').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    const f = $('export-form');
    const today = state.today;
    const monthStart = today.slice(0, 8) + '01';
    const ranges = {
      today: [today, today],
      week: [addDays(today, -6), today],
      month: [monthStart, today],
      last_month: [addDays(monthStart, -1).slice(0, 8) + '01', addDays(monthStart, -1)],
    };
    [f.from.value, f.to.value] = ranges[b.dataset.range];
  });
  $('export-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const kind = e.submitter?.dataset.format || 'xlsx';
    const params = new URLSearchParams({ from: f.from.value, to: f.to.value, lang: f.lang.value,
      format: kind === 'xlsx' ? 'xlsx' : 'csv' });
    if (kind === 'csv_summary') params.set('view', 'summary');
    window.location.href = '/api/hr/export?' + params;
  });

  /* ---------- اللغة ---------- */
  document.addEventListener('langchange', () => {
    renderOverview();
    renderRecords();
    renderEmployees();
  });

  /* ---------- البداية ---------- */
  (async () => {
    const me = await api('/api/hr/me');
    if (me.ok) showApp(me.user); else showLogin();
  })();
})();

// public/js/hr.js — منطق لوحة الموارد البشرية
(() => {
  const $ = (id) => document.getElementById(id);
  const TABS = ['live', 'records', 'excuses', 'employees', 'reminders', 'export', 'settings'];
  const state = {
    tab: 'live', today: null, liveDate: null, overview: null, filter: 'all', search: '',
    employees: [], empSearch: '', records: null, stream: null,
    excuses: [], excuseStatus: 'pending', excuseSearch: '', reminders: null, settings: null,
  };

  /* ---------- أدوات ---------- */
  function toast(msg, kind = 'info') {
    const colors = { info: 'background:var(--ink);color:#fff', error: 'background:var(--red);color:#fff', success: 'background:var(--blue);color:#fff' };
    const el = document.createElement('div');
    el.className = 'pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm font-semibold shadow-lg transition-opacity';
    el.style.cssText = colors[kind];
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }
  async function call(url, opts) {
    const data = await api(url, opts);
    if (data.status === 401 && !url.endsWith('/login')) showLogin();
    return data;
  }
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
  const badge = (cls, text) => `<span class="badge b-${cls}">${escapeHtml(text)}</span>`;
  const statusBadge = (s) => badge(s, t('status_' + s));
  const typeBadge = (type) => badge(type === 'in' ? 'in' : 'out', t(type));
  const empty = (msg = t('no_data')) => `<p class="py-10 text-center text-sm muted">${escapeHtml(msg)}</p>`;
  const b = (v) => `<b class="tabular" dir="ltr">${escapeHtml(v)}</b>`;

  /* ---------- الدخول والخروج ---------- */
  function showLogin() {
    if (state.stream) { state.stream.close(); state.stream = null; }
    $('app-view').hidden = true;
    $('login-view').hidden = false;
  }
  async function showApp(me) {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    const time = await call('/api/time');
    state.today = time.date;
    state.liveDate = state.today;
    $('company-name').textContent = time.company || t('hr_title');
    $('live-date').value = state.today;
    initForms();
    connectStream();
    setTab((location.hash || '#live').slice(1));
    if (me.must_change) openPassword(true);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = await call('/api/hr/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    if (!data.ok) { $('login-error').textContent = errorText(data); $('login-error').hidden = false; return; }
    $('login-error').hidden = true;
    e.target.reset();
    showApp(data.user);
  });
  async function logout() { await call('/api/hr/logout', { method: 'POST' }); showLogin(); }
  $('btn-logout').addEventListener('click', logout);

  /* ---------- كلمة المرور ---------- */
  function openPassword(must = false) {
    $('pw-must').hidden = !must;
    $('pw-error').hidden = true;
    $('pw-form').reset();
    $('pw-dialog').showModal();
  }
  $('btn-password').addEventListener('click', () => openPassword(false));
  $('pw-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const data = await call('/api/hr/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
    if (!data.ok) { $('pw-error').textContent = errorText(data); $('pw-error').hidden = false; return; }
    $('pw-dialog').close();
    toast(t('saved'), 'success');
  });

  /* ---------- التبويبات ---------- */
  function setTab(tab) {
    if (!TABS.includes(tab)) tab = 'live';
    state.tab = tab;
    history.replaceState(null, '', '#' + tab);
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + tab; });
    document.querySelectorAll('.tab-btn[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
    $('btn-more').setAttribute('aria-selected', String(['reminders', 'export', 'settings'].includes(tab)));
    loadTab(tab);
    window.scrollTo({ top: 0 });
  }
  function loadTab(tab) {
    ({ live: loadOverview, records: loadRecords, excuses: loadExcuses, employees: loadEmployees,
      reminders: loadReminders, settings: loadSettings })[tab]?.();
  }
  document.querySelectorAll('.tab-btn[data-tab]').forEach((x) => x.addEventListener('click', () => setTab(x.dataset.tab)));
  $('btn-more').addEventListener('click', () => $('more-dialog').showModal());
  $('more-dialog').addEventListener('click', (e) => { if (e.target === $('more-dialog')) $('more-dialog').close(); });
  document.querySelectorAll('[data-goto]').forEach((x) => x.addEventListener('click', () => {
    $('more-dialog').close(); setTab(x.dataset.goto);
  }));
  $('more-password').addEventListener('click', () => { $('more-dialog').close(); openPassword(false); });
  $('more-logout').addEventListener('click', () => { $('more-dialog').close(); logout(); });

  function setPending(n) {
    document.querySelectorAll('.pending-pill').forEach((p) => { p.textContent = n; p.hidden = !n; });
  }

  /* ---------- مباشر ---------- */
  async function loadOverview() {
    const data = await call('/api/hr/overview?date=' + encodeURIComponent(state.liveDate || ''));
    if (!data.ok) return;
    state.overview = data;
    setPending(data.pending_excuses);
    renderOverview();
  }

  function renderOverview() {
    const o = state.overview;
    if (!o) return;
    for (const k of ['in', 'out', 'absent', 'excused', 'late', 'total']) $('stat-' + k).textContent = o.stats[k];
    $('live-hours').textContent = `${o.work.start} – ${o.work.end}`;
    $('day-off').hidden = !o.day_off;
    document.querySelectorAll('.stat').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.filter === state.filter)));

    const q = state.search.toLowerCase();
    const list = o.employees.filter((e) => {
      const f = state.filter;
      const okFilter = f === 'all' || (f === 'late' ? e.late_minutes > 0 && !e.excuse_type : e.status === f);
      return okFilter && (!q || `${e.name} ${e.emp_no} ${e.department}`.toLowerCase().includes(q));
    });
    $('live-list').innerHTML = list.length ? list.map((e) => `
      <li class="flex items-center gap-3 border-b py-3 last:border-0" style="border-color:var(--blue-100)">
        <div class="avatar">${escapeHtml(initials(e.name))}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate font-semibold">${escapeHtml(e.name)}</div>
          <div class="truncate text-xs muted"><span class="tabular" dir="ltr">#${escapeHtml(e.emp_no)}</span>${e.department ? ' · ' + escapeHtml(e.department) : ''}</div>
          ${e.first_in ? `<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs muted">
            <span>${escapeHtml(t('first_in'))} ${b(e.first_in)}</span>
            ${e.last_out ? `<span>${escapeHtml(t('last_out'))} ${b(e.last_out)}</span>` : ''}
            <span>${escapeHtml(t('hours'))} ${b(e.hours)}</span></div>` : ''}
        </div>
        <div class="flex flex-col items-end gap-1">
          ${statusBadge(e.status)}
          ${e.late_minutes && !e.excuse_type ? badge('late', t('late_by', { m: fmtMins(e.late_minutes) })) : ''}
          ${e.excuse_type && e.status !== 'excused' ? badge('excused', t('ex_' + e.excuse_type)) : ''}
        </div>
      </li>`).join('') : empty();

    $('recent-list').innerHTML = o.recent.length ? o.recent.map((r) => `
      <li class="flex items-center gap-2 text-sm">
        <span class="h-2 w-2 shrink-0 rounded-full" style="background:${r.type === 'in' ? 'var(--green)' : 'var(--blue)'}"></span>
        <span class="min-w-0 flex-1 truncate">${escapeHtml(r.name)}</span>
        <span class="text-xs muted">${escapeHtml(t(r.type))}</span>
        <span class="tabular text-xs font-semibold" dir="ltr">${escapeHtml(r.time)}</span>
      </li>`).join('') : empty();
  }

  document.querySelectorAll('.stat').forEach((s) => s.addEventListener('click', () => { state.filter = s.dataset.filter; renderOverview(); }));
  $('live-search').addEventListener('input', (e) => { state.search = e.target.value; renderOverview(); });
  $('live-date').addEventListener('change', (e) => { state.liveDate = e.target.value || state.today; loadOverview(); });

  /* ---------- البث اللحظي ---------- */
  let reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (['live', 'records', 'excuses', 'employees'].includes(state.tab)) loadTab(state.tab);
      else call('/api/hr/excuses?status=pending').then((d) => d.ok && setPending(d.pending));
    }, 400);
  }
  function connectStream() {
    if (state.stream) state.stream.close();
    const es = new EventSource('/api/hr/stream');
    state.stream = es;
    es.onopen = () => $('live-dot').classList.remove('offline');
    es.addEventListener('punch', (e) => {
      const r = JSON.parse(e.data);
      toast(t(r.type === 'in' ? 'new_punch_in' : 'new_punch_out', { name: r.name }), r.type === 'in' ? 'success' : 'info');
      scheduleReload();
    });
    es.addEventListener('excuse', (e) => {
      toast(t('new_excuse', { name: JSON.parse(e.data).name }), 'success');
      scheduleReload();
    });
    es.addEventListener('refresh', scheduleReload);
    es.onerror = async () => {
      $('live-dot').classList.add('offline');
      const me = await api('/api/hr/me');
      if (me.status === 401) showLogin();
    };
  }
  setInterval(() => { if (state.tab === 'live' && !$('app-view').hidden) loadOverview(); }, 60000);

  /* ---------- النماذج: القيم الافتراضية ---------- */
  function initForms() {
    const r = $('records-form');
    if (!r.from.value) { r.from.value = addDays(state.today, -6); r.to.value = state.today; }
    $('manual-form').date.value = state.today;
    $('excuse-form').date_from.value = state.today;
    const x = $('export-form');
    if (!x.from.value) { x.from.value = state.today.slice(0, 8) + '01'; x.to.value = state.today; }
    renderBeforeOptions();
  }

  /* ---------- السجلات ---------- */
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
    const th = (k) => `<th>${escapeHtml(t(k))}</th>`;
    const li = (inner) => `<li class="border-b py-3 last:border-0" style="border-color:var(--blue-100)">${inner}</li>`;

    if (d.view === 'period') {
      $('records-out').innerHTML = `
        <ul class="md:hidden">${d.rows.map((r) => li(`
          <div class="flex items-center justify-between gap-2"><span class="truncate font-semibold">${escapeHtml(r.name)}</span><span class="tabular text-xs muted" dir="ltr">#${escapeHtml(r.emp_no)}</span></div>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            ${badge('in', `${t('present')} ${r.present}/${r.workdays}`)} ${r.absent ? badge('absent', `${t('absent')} ${r.absent}`) : ''}
            ${r.excused ? badge('excused', `${t('excused')} ${r.excused}`) : ''} ${r.late_count ? badge('late', `${t('late_days')} ${r.late_count} · ${r.late_minutes}m`) : ''}
            ${badge('out', `${t('hours')} ${r.hours}`)}</div>`)).join('')}</ul>
        <table class="tbl hidden md:table">
          <thead><tr>${['emp_no', 'name', 'workdays', 'present', 'absent', 'excused', 'late_days', 'late_min', 'early', 'hours'].map(th).join('')}</tr></thead>
          <tbody>${d.rows.map((r) => `<tr>
            <td class="tabular">${escapeHtml(r.emp_no)}</td><td class="font-semibold">${escapeHtml(r.name)}</td>
            <td class="tabular">${r.workdays}</td><td class="tabular">${r.present}</td>
            <td class="tabular" style="color:${r.absent ? 'var(--red)' : 'inherit'}">${r.absent}</td><td class="tabular">${r.excused}</td>
            <td class="tabular">${r.late_count}</td><td class="tabular">${r.late_minutes}</td><td class="tabular">${r.early_count}</td>
            <td class="tabular font-semibold">${escapeHtml(r.hours)}</td></tr>`).join('')}</tbody>
        </table>`;
      return;
    }

    if (d.view === 'summary') {
      const flags = (r) => [
        r.late_minutes && !r.excuse_type ? badge('late', t('late_by', { m: fmtMins(r.late_minutes) })) : '',
        r.early_minutes && !r.excuse_type ? badge('late', t('early_by', { m: fmtMins(r.early_minutes) })) : '',
        r.excuse_type ? badge('excused', t('ex_' + r.excuse_type)) : '',
      ].join(' ');
      $('records-out').innerHTML = `
        <ul class="md:hidden">${d.rows.map((r) => li(`
          <div class="flex items-center justify-between gap-2"><span class="truncate font-semibold">${escapeHtml(r.name)}</span>${statusBadge(r.status)}</div>
          <div class="mt-1 flex flex-wrap gap-x-3 text-xs muted">
            <span>${escapeHtml(fmtDate(r.work_date))}</span>
            <span>${escapeHtml(t('first_in'))} ${b(r.first_in_time || '—')}</span>
            <span>${escapeHtml(t('last_out'))} ${b(r.last_out_time || '—')}</span>
            <span>${escapeHtml(t('hours'))} ${b(r.hours)}</span></div>
          <div class="mt-1.5 flex flex-wrap gap-1">${flags(r)}</div>`)).join('')}</ul>
        <table class="tbl hidden md:table">
          <thead><tr>${['date', 'emp_no', 'name', 'first_in', 'last_out', 'hours'].map(th).join('')}<th></th><th></th></tr></thead>
          <tbody>${d.rows.map((r) => `<tr>
            <td class="tabular">${escapeHtml(fmtDate(r.work_date))}</td><td class="tabular">${escapeHtml(r.emp_no)}</td>
            <td class="font-semibold">${escapeHtml(r.name)}</td><td class="tabular" dir="ltr">${escapeHtml(r.first_in_time || '—')}</td>
            <td class="tabular" dir="ltr">${escapeHtml(r.last_out_time || '—')}</td><td class="tabular font-semibold">${escapeHtml(r.hours)}</td>
            <td>${flags(r)}</td><td>${statusBadge(r.status)}</td></tr>`).join('')}</tbody>
        </table>`;
      return;
    }

    const del = (r) => `<button data-del-rec="${r.id}" class="btn btn-danger btn-sm">${escapeHtml(t('delete'))}</button>`;
    const src = (r) => (r.source === 'hr' ? `<span class="text-xs muted">${escapeHtml(t('source_hr'))}</span>` : '');
    $('records-out').innerHTML = `
      <ul class="md:hidden">${d.rows.map((r) => li(`<div class="flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2"><span class="truncate font-semibold">${escapeHtml(r.name)}</span>${typeBadge(r.type)}${src(r)}</div>
            <div class="mt-0.5 text-xs muted">${escapeHtml(fmtDate(r.work_date))} · ${b(r.time)} · <span class="tabular" dir="ltr">#${escapeHtml(r.emp_no)}</span></div>
          </div>${del(r)}</div>`)).join('')}</ul>
      <table class="tbl hidden md:table">
        <thead><tr>${['date', 'time', 'emp_no', 'name', 'department', 'type'].map(th).join('')}<th></th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr>
          <td class="tabular">${escapeHtml(fmtDate(r.work_date))}</td><td class="tabular" dir="ltr">${escapeHtml(r.time)}</td>
          <td class="tabular">${escapeHtml(r.emp_no)}</td><td class="font-semibold">${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.department)}</td><td>${typeBadge(r.type)} ${src(r)}</td><td class="text-end">${del(r)}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  $('records-form').addEventListener('submit', (e) => { e.preventDefault(); loadRecords(); });
  $('records-out').addEventListener('click', async (e) => {
    const x = e.target.closest('[data-del-rec]');
    if (!x || !confirm(t('confirm_delete_rec'))) return;
    const data = await call('/api/hr/records/' + x.dataset.delRec, { method: 'DELETE' });
    if (data.ok) { toast(t('deleted')); loadRecords(); } else toast(errorText(data), 'error');
  });
  $('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await call('/api/hr/records', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('saved'), 'success');
    e.target.emp_no.value = ''; e.target.note.value = '';
    loadRecords();
  });

  /* ---------- الأعذار ---------- */
  async function loadExcuses() {
    const params = new URLSearchParams({ status: state.excuseStatus, q: state.excuseSearch });
    const data = await call('/api/hr/excuses?' + params);
    if (!data.ok) return;
    state.excuses = data.excuses;
    setPending(data.pending);
    renderExcuses();
  }
  function renderExcuses() {
    document.querySelectorAll('#excuse-chips [data-status]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.status === state.excuseStatus)));
    $('excuse-list').innerHTML = state.excuses.length ? state.excuses.map((x) => `
      <li class="card flex flex-col p-4" data-excuse="${x.id}" style="${x.status === 'pending' ? 'border-color:var(--blue)' : ''}">
        <div class="flex items-start gap-3">
          <div class="avatar">${escapeHtml(initials(x.name))}</div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">${escapeHtml(x.name)}</div>
            <div class="text-xs muted"><span class="tabular" dir="ltr">#${escapeHtml(x.emp_no)}</span> · ${escapeHtml(t(x.submitted_by === 'hr' ? 'by_hr' : 'by_employee'))}</div>
          </div>
          ${badge(x.status, t('st_' + x.status))}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          ${badge('excused', t('ex_' + x.type))}
          <span class="text-sm font-medium tabular">${escapeHtml(fmtRange(x.date_from, x.date_to))}</span>
        </div>
        ${x.reason ? `<p class="mt-2 whitespace-pre-line text-sm">${escapeHtml(x.reason)}</p>` : ''}
        ${x.has_attachment ? `<a href="/api/hr/excuses/${x.id}/attachment" target="_blank" rel="noopener" class="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold" style="color:var(--blue)">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9"/></svg>
          ${escapeHtml(t('view_attachment'))}</a>` : ''}
        <div class="mt-auto pt-3">
          <input class="field py-2 text-sm" data-note value="${escapeHtml(x.hr_note)}" placeholder="${escapeHtml(t('hr_note_ph'))}">
          ${x.decided_by ? `<p class="mt-1.5 text-xs muted">${escapeHtml(t('decided', { s: t('st_' + x.status), by: x.decided_by }))} · <span class="tabular" dir="ltr">${escapeHtml(x.decided_label)}</span></p>` : ''}
          <div class="mt-2 flex flex-wrap gap-2">
            ${x.status !== 'approved' ? `<button class="btn btn-success btn-sm" data-decide="approved">${escapeHtml(t('approve'))}</button>` : ''}
            ${x.status !== 'rejected' ? `<button class="btn btn-danger btn-sm" data-decide="rejected">${escapeHtml(t('reject'))}</button>` : ''}
            ${x.status !== 'pending' ? `<button class="btn btn-ghost btn-sm" data-decide="pending">${escapeHtml(t('reset_pending'))}</button>` : ''}
            <button class="btn btn-ghost btn-sm ms-auto" data-del-excuse aria-label="delete">${escapeHtml(t('delete'))}</button>
          </div>
        </div>
      </li>`).join('') : `<li class="md:col-span-2">${empty()}</li>`;
  }
  document.querySelectorAll('#excuse-chips [data-status]').forEach((c) => c.addEventListener('click', () => {
    state.excuseStatus = c.dataset.status; loadExcuses();
  }));
  let excuseSearchTimer;
  $('excuse-search').addEventListener('input', (e) => {
    clearTimeout(excuseSearchTimer);
    excuseSearchTimer = setTimeout(() => { state.excuseSearch = e.target.value; loadExcuses(); }, 300);
  });
  $('excuse-list').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-excuse]');
    if (!card) return;
    const id = card.dataset.excuse;
    const decide = e.target.closest('[data-decide]');
    if (decide) {
      const data = await call('/api/hr/excuses/' + id, { method: 'PUT',
        body: { status: decide.dataset.decide, hr_note: card.querySelector('[data-note]').value } });
      if (!data.ok) return toast(errorText(data), 'error');
      toast(t('st_' + decide.dataset.decide), decide.dataset.decide === 'rejected' ? 'error' : 'success');
      loadExcuses();
    }
    if (e.target.closest('[data-del-excuse]') && confirm(t('confirm_delete'))) {
      const data = await call('/api/hr/excuses/' + id, { method: 'DELETE' });
      if (data.ok) { toast(t('deleted')); loadExcuses(); } else toast(errorText(data), 'error');
    }
  });
  $('excuse-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    const body = { emp_no: f.emp_no.value, type: f.type.value, date_from: f.date_from.value, date_to: f.date_to.value || f.date_from.value,
      reason: f.reason.value, status: f.status.value, attachment: await readAttachment(f.file.files[0]) };
    const data = await call('/api/hr/excuses', { method: 'POST', body });
    btn.disabled = false;
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('saved'), 'success');
    f.emp_no.value = ''; f.reason.value = ''; f.file.value = ''; f.date_to.value = '';
    loadExcuses();
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
      <li class="flex flex-wrap items-center gap-3 border-b py-3 last:border-0 ${e.active ? '' : 'opacity-60'}" style="border-color:var(--blue-100)">
        <div class="avatar">${escapeHtml(initials(e.name))}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2"><span class="truncate font-semibold">${escapeHtml(e.name)}</span>${e.active ? '' : badge('off', t('inactive'))}</div>
          <div class="truncate text-xs muted"><span class="tabular" dir="ltr">#${escapeHtml(e.emp_no)}</span>${e.department ? ' · ' + escapeHtml(e.department) : ''}${e.job_title ? ' · ' + escapeHtml(e.job_title) : ''}</div>
        </div>
        <div class="flex gap-1.5">
          <button data-edit="${e.id}" class="btn btn-ghost btn-sm">${escapeHtml(t('edit'))}</button>
          <button data-toggle="${e.id}" class="btn btn-ghost btn-sm">${escapeHtml(t(e.active ? 'deactivate' : 'activate'))}</button>
          <button data-del-emp="${e.id}" class="btn btn-danger btn-sm">${escapeHtml(t('delete'))}</button>
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
      $('edit-error').hidden = true;
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
    if (!data.ok) { $('edit-error').textContent = errorText(data); $('edit-error').hidden = false; return; }
    $('edit-dialog').close();
    toast(t('saved'), 'success');
    loadEmployees();
  });
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $('import-result');
    out.hidden = false;
    out.style.color = 'var(--muted)';
    out.textContent = t('loading');
    const data = await call('/api/hr/employees/import', {
      method: 'POST', body: await file.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' },
    });
    e.target.value = '';
    if (!data.ok) { out.style.color = 'var(--red)'; out.textContent = errorText(data); return; }
    out.style.color = 'var(--blue)';
    const errs = data.errors.slice(0, 5).map((x) => `• ${x.row}${x.emp_no ? ' (' + x.emp_no + ')' : ''}: ${t('err_' + x.error)}`).join('\n');
    out.textContent = t('imported', { added: data.added, updated: data.updated, errors: data.errors.length }) + (errs ? '\n' + errs : '');
    loadEmployees();
  });

  /* ---------- التذكيرات ---------- */
  const BEFORE = [0, 1, 3, 7, 14, 30, 60, 90];
  function renderBeforeOptions() {
    const sel = $('before-select');
    const v = sel.value;
    sel.innerHTML = BEFORE.map((n) => `<option value="${n}">${escapeHtml(n ? t('days_n', { n }) : t('days_0'))}</option>`).join('');
    if (v) sel.value = v;
  }
  async function loadReminders() {
    const data = await call('/api/hr/reminders');
    if (!data.ok) return;
    state.reminders = data;
    renderReminders();
  }
  function renderReminders() {
    const d = state.reminders;
    if (!d) return;
    $('email-warning').hidden = d.email_configured;
    $('reminder-list').innerHTML = d.reminders.length ? d.reminders.map((r) => {
      const left = daysBetween(d.today, r.due_date);
      const when = left > 0 ? t('days_left', { n: left }) : left === 0 ? t('due_today') : t('overdue');
      const urgent = r.active && left <= Math.max(7, r.notify_before_days);
      return `
      <li class="card flex flex-col p-4 ${r.active ? '' : 'opacity-60'}" data-reminder="${r.id}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-bold">${escapeHtml(r.title)}</div>
            <div class="text-xs muted">${escapeHtml(t('cat_' + r.category))}</div>
          </div>
          ${r.active ? badge('out', t('rep_' + r.repeat)) : badge('off', t('paused'))}
        </div>
        <div class="card-soft mt-3 flex items-center justify-between gap-2 px-3 py-2.5" style="${urgent ? 'background:#fff8ec;border-color:#f6dfb2' : ''}">
          <div><div class="text-xs muted">${escapeHtml(t('next_due'))}</div><div class="font-bold tabular">${escapeHtml(fmtDate(r.due_date))}</div></div>
          <span class="text-sm font-semibold" style="color:${urgent ? 'var(--amber)' : 'var(--blue)'}">${escapeHtml(when)}</span>
        </div>
        <p class="mt-2 text-xs muted">${escapeHtml(r.notify_before_days ? t('days_n', { n: r.notify_before_days }) : t('days_0'))}</p>
        <p class="mt-1 break-all text-xs" dir="ltr">${escapeHtml(r.recipients)}</p>
        ${r.details ? `<p class="mt-2 whitespace-pre-line text-sm">${escapeHtml(r.details)}</p>` : ''}
        ${r.last_sent_label ? `<p class="mt-2 text-xs muted">${escapeHtml(t('last_sent'))}: <span class="tabular" dir="ltr">${escapeHtml(r.last_sent_label)}</span></p>` : ''}
        <div class="mt-auto flex flex-wrap gap-1.5 pt-3">
          <button class="btn btn-ghost btn-sm" data-r="edit">${escapeHtml(t('edit'))}</button>
          <button class="btn btn-ghost btn-sm" data-r="send">${escapeHtml(t('send_now'))}</button>
          <button class="btn btn-ghost btn-sm" data-r="toggle">${escapeHtml(t(r.active ? 'pause' : 'resume'))}</button>
          <button class="btn btn-danger btn-sm ms-auto" data-r="delete">${escapeHtml(t('delete'))}</button>
        </div>
      </li>`;
    }).join('') : `<li class="md:col-span-2 card">${empty(t('reminders_hint'))}</li>`;

    const logCls = { sent: 'approved', test: 'out', failed: 'rejected' };
    $('reminder-log').innerHTML = d.logs.length ? d.logs.map((l) => `
      <li class="flex flex-wrap items-center gap-2">
        ${badge(logCls[l.status] || 'off', t('log_' + l.status))}
        <span class="font-medium">${escapeHtml(l.title)}</span>
        <span class="tabular text-xs muted" dir="ltr">${escapeHtml(l.sent_label)}</span>
        ${l.message ? `<span class="w-full text-xs" style="color:var(--red)" dir="ltr">${escapeHtml(l.message)}</span>` : ''}
      </li>`).join('') : `<li class="text-sm muted">${escapeHtml(t('no_data'))}</li>`;
  }
  function openReminder(r) {
    const f = $('reminder-form');
    f.reset();
    renderBeforeOptions();
    $('reminder-dialog-title').textContent = t(r ? 'edit_reminder' : 'add_reminder');
    $('reminder-error').hidden = true;
    f.id.value = r?.id || '';
    f.title.value = r?.title || '';
    f.category.value = r?.category || 'document';
    f.recipients.value = r?.recipients || '';
    f.due_date.value = r?.due_date || state.today;
    f.repeat.value = r?.repeat || 'yearly';
    f.notify_before_days.value = String(r ? (BEFORE.includes(r.notify_before_days) ? r.notify_before_days : 0) : 30);
    f.details.value = r?.details || '';
    $('reminder-dialog').showModal();
  }
  $('btn-add-reminder').addEventListener('click', () => openReminder(null));
  $('reminder-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const id = body.id;
    delete body.id;
    const data = await call(id ? '/api/hr/reminders/' + id : '/api/hr/reminders', { method: id ? 'PUT' : 'POST', body });
    if (!data.ok) { $('reminder-error').textContent = errorText(data); $('reminder-error').hidden = false; return; }
    $('reminder-dialog').close();
    toast(t('saved'), 'success');
    loadReminders();
  });
  $('reminder-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-r]');
    if (!btn) return;
    const id = Number(btn.closest('[data-reminder]').dataset.reminder);
    const r = state.reminders.reminders.find((x) => x.id === id);
    const act = btn.dataset.r;
    if (act === 'edit') return openReminder(r);
    if (act === 'delete' && !confirm(t('confirm_delete'))) return;
    btn.disabled = true;
    const req = {
      send: ['/api/hr/reminders/' + id + '/send', { method: 'POST' }],
      toggle: ['/api/hr/reminders/' + id, { method: 'PUT', body: { active: !r.active } }],
      delete: ['/api/hr/reminders/' + id, { method: 'DELETE' }],
    }[act];
    const data = await call(...req);
    btn.disabled = false;
    if (!data.ok) { toast(errorText(data), 'error'); return loadReminders(); }
    toast(t(act === 'send' ? 'sent_ok' : act === 'delete' ? 'deleted' : 'saved'), 'success');
    loadReminders();
  });

  /* ---------- التصدير ---------- */
  $('quick-ranges').addEventListener('click', (e) => {
    const x = e.target.closest('[data-range]');
    if (!x) return;
    const f = $('export-form');
    const today = state.today;
    const monthStart = today.slice(0, 8) + '01';
    const ranges = {
      today: [today, today], week: [addDays(today, -6), today], month: [monthStart, today],
      last_month: [addDays(monthStart, -1).slice(0, 8) + '01', addDays(monthStart, -1)],
    };
    [f.from.value, f.to.value] = ranges[x.dataset.range];
  });
  $('export-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const kind = e.submitter?.dataset.format || 'xlsx';
    const params = new URLSearchParams({ from: f.from.value, to: f.to.value });
    if (kind !== 'xlsx') { params.set('format', 'csv'); params.set('view', kind.replace('csv_', '')); }
    window.location.href = '/api/hr/export?' + params;
  });

  /* ---------- الإعدادات ---------- */
  async function loadSettings() {
    const data = await call('/api/hr/settings');
    if (!data.ok) return;
    state.settings = data.settings;
    renderSettings();
  }
  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    const f = $('settings-form');
    f.company_name.value = s.company_name;
    f.work_start.value = s.work_start;
    f.work_end.value = s.work_end;
    f.grace_minutes.value = s.grace_minutes;
    f.mail_from.value = s.mail_from;
    f.resend_api_key.value = '';
    $('weekend-days').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((d) => `
      <label class="chip cursor-pointer select-none" aria-pressed="${s.weekend.includes(d)}">
        <input type="checkbox" class="sr-only" value="${d}" ${s.weekend.includes(d) ? 'checked' : ''}>${escapeHtml(t('d' + d))}</label>`).join('');
    const st = $('email-status');
    st.className = 'badge ' + (s.email_configured ? 'b-approved' : 'b-pending');
    st.textContent = t(s.email_configured ? 'email_ok' : 'email_off');
  }
  $('weekend-days').addEventListener('change', (e) => {
    e.target.closest('label').setAttribute('aria-pressed', String(e.target.checked));
  });
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      company_name: f.company_name.value, work_start: f.work_start.value, work_end: f.work_end.value,
      grace_minutes: f.grace_minutes.value, mail_from: f.mail_from.value,
      weekend: [...$('weekend-days').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    };
    if (f.resend_api_key.value.trim()) body.resend_api_key = f.resend_api_key.value.trim();
    const data = await call('/api/hr/settings', { method: 'PUT', body });
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('saved'), 'success');
    $('company-name').textContent = body.company_name;
    loadSettings();
  });
  $('btn-test-email').addEventListener('click', async (e) => {
    const to = $('test-email').value.trim();
    if (!to) return $('test-email').focus();
    e.target.disabled = true;
    const data = await call('/api/hr/settings/test-email', { method: 'POST', body: { to } });
    e.target.disabled = false;
    if (!data.ok) return toast(errorText(data), 'error');
    toast(t('sent_ok'), 'success');
  });

  /* ---------- اللغة ---------- */
  document.addEventListener('langchange', () => {
    renderOverview(); renderRecords(); renderEmployees(); renderExcuses();
    renderBeforeOptions(); renderReminders(); renderSettings();
  });

  /* ---------- البداية ---------- */
  (async () => {
    const me = await api('/api/hr/me');
    if (me.ok) showApp(me.user); else showLogin();
  })();
})();

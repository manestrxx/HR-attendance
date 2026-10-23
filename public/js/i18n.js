// public/js/i18n.js — الترجمة والتبديل بين العربية والإنجليزية
const I18N = {
  ar: {
    app_name: 'نظام الحضور',
    employee_title: 'تسجيل الحضور والانصراف',
    emp_no: 'الرقم الوظيفي',
    pin: 'الرمز السري',
    remember: 'تذكّر رقمي على هذا الجهاز',
    check_in: 'تسجيل حضور',
    check_out: 'تسجيل انصراف',
    hr_link: 'دخول الموارد البشرية',
    success_in: 'تم تسجيل حضورك',
    success_out: 'تم تسجيل انصرافك',
    worked_today: 'ساعات العمل اليوم',
    at: 'الساعة',
    hello: 'مرحبًا',
    loading: 'جارٍ التحميل…',
    // HR
    hr_title: 'لوحة الموارد البشرية',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    login: 'دخول',
    logout: 'خروج',
    tab_live: 'مباشر',
    tab_records: 'السجلات',
    tab_employees: 'الموظفون',
    tab_export: 'التصدير',
    stat_in: 'داخل العمل',
    stat_out: 'انصرفوا',
    stat_absent: 'لم يحضروا',
    stat_total: 'إجمالي الموظفين',
    status_in: 'داخل العمل',
    status_out: 'انصرف',
    status_absent: 'لم يحضر',
    all: 'الكل',
    search: 'بحث بالاسم أو الرقم أو القسم',
    recent: 'آخر الحركات',
    live: 'مباشر',
    no_data: 'لا توجد بيانات',
    first_in: 'أول دخول',
    last_out: 'آخر خروج',
    hours: 'الساعات',
    date: 'التاريخ',
    from: 'من',
    to: 'إلى',
    time: 'الوقت',
    type: 'الحركة',
    in: 'حضور',
    out: 'انصراف',
    name: 'الاسم',
    department: 'القسم',
    job_title: 'المسمى الوظيفي',
    view_movements: 'الحركات',
    view_summary: 'الملخص اليومي',
    show: 'عرض',
    add_record: 'إضافة حركة يدوية',
    note: 'ملاحظة',
    save: 'حفظ',
    cancel: 'إلغاء',
    delete: 'حذف',
    edit: 'تعديل',
    add_employee: 'إضافة موظف',
    new_pin: 'رمز سري جديد (اتركه فارغًا لعدم التغيير)',
    pin_hint: 'من 4 إلى 6 أرقام',
    import_title: 'رفع الموظفين من ملف',
    import_hint: 'ملف Excel أو CSV يحتوي الأعمدة: emp_no, name, department, job_title, pin',
    choose_file: 'اختيار ملف',
    template_xlsx: 'قالب Excel',
    template_csv: 'قالب CSV',
    active: 'نشط',
    inactive: 'موقوف',
    deactivate: 'إيقاف',
    activate: 'تفعيل',
    confirm_delete_emp: 'حذف الموظف سيحذف جميع سجلاته نهائيًا. هل أنت متأكد؟',
    confirm_delete_rec: 'حذف هذه الحركة؟',
    export_title: 'تصدير التقارير',
    export_hint: 'ملف Excel يحتوي ورقتين: الملخص اليومي (أول دخول، آخر خروج، ساعات العمل) وجميع الحركات.',
    today: 'اليوم',
    this_week: 'آخر 7 أيام',
    this_month: 'هذا الشهر',
    last_month: 'الشهر الماضي',
    file_lang: 'لغة الملف',
    arabic: 'العربية',
    english: 'English',
    export_excel: 'تحميل Excel',
    export_csv: 'CSV الحركات',
    export_csv_summary: 'CSV الملخص',
    change_password: 'تغيير كلمة المرور',
    current_password: 'كلمة المرور الحالية',
    new_password: 'كلمة المرور الجديدة (8 أحرف على الأقل)',
    must_change: 'لأمان النظام، غيّر كلمة المرور الافتراضية الآن.',
    saved: 'تم الحفظ',
    deleted: 'تم الحذف',
    imported: 'تمت الإضافة: {added} • التحديث: {updated} • أخطاء: {errors}',
    new_punch_in: 'حضور: {name}',
    new_punch_out: 'انصراف: {name}',
    source_hr: 'يدوي',
    rows_count: '{n} سجل',
    connection_lost: 'انقطع الاتصال المباشر، جارٍ إعادة المحاولة…',
    // الأخطاء
    err_missing_fields: 'يرجى تعبئة جميع الحقول المطلوبة',
    err_invalid_credentials: 'الرقم الوظيفي أو الرمز السري غير صحيح',
    err_too_many_attempts: 'محاولات كثيرة خاطئة. حاول بعد {s} ثانية',
    err_inactive: 'حسابك موقوف، راجع الموارد البشرية',
    err_already_in: 'أنت مسجّل حضور مسبقًا منذ {since}',
    err_not_in: 'لا يوجد تسجيل حضور مفتوح. سجّل حضورك أولًا',
    err_invalid_pin: 'الرمز السري يجب أن يكون من 4 إلى 6 أرقام',
    err_emp_no_exists: 'هذا الرقم الوظيفي مستخدم مسبقًا',
    err_employee_not_found: 'الموظف غير موجود',
    err_invalid_fields: 'بيانات غير صحيحة',
    err_password_too_short: 'كلمة المرور قصيرة (8 أحرف على الأقل)',
    err_wrong_password: 'كلمة المرور الحالية غير صحيحة',
    err_missing_columns: 'الملف يجب أن يحتوي عمودي emp_no و name على الأقل',
    err_unreadable_file: 'تعذّرت قراءة الملف',
    err_empty_file: 'الملف فارغ',
    err_file_too_large: 'حجم الملف كبير جدًا',
    err_network: 'تعذّر الاتصال بالخادم، تحقق من الإنترنت',
    err_server_error: 'حدث خطأ في الخادم',
    err_unauthorized: 'انتهت الجلسة، سجّل الدخول من جديد',
  },
  en: {
    app_name: 'Attendance',
    employee_title: 'Check in & out',
    emp_no: 'Employee No.',
    pin: 'PIN',
    remember: 'Remember my number on this device',
    check_in: 'Check in',
    check_out: 'Check out',
    hr_link: 'HR sign in',
    success_in: 'You are checked in',
    success_out: 'You are checked out',
    worked_today: 'Worked today',
    at: 'at',
    hello: 'Hello',
    loading: 'Loading…',
    hr_title: 'HR Dashboard',
    username: 'Username',
    password: 'Password',
    login: 'Sign in',
    logout: 'Sign out',
    tab_live: 'Live',
    tab_records: 'Records',
    tab_employees: 'Employees',
    tab_export: 'Export',
    stat_in: 'At work',
    stat_out: 'Checked out',
    stat_absent: 'Not in yet',
    stat_total: 'Total employees',
    status_in: 'At work',
    status_out: 'Checked out',
    status_absent: 'Absent',
    all: 'All',
    search: 'Search name, number or department',
    recent: 'Latest activity',
    live: 'Live',
    no_data: 'No data',
    first_in: 'First in',
    last_out: 'Last out',
    hours: 'Hours',
    date: 'Date',
    from: 'From',
    to: 'To',
    time: 'Time',
    type: 'Action',
    in: 'In',
    out: 'Out',
    name: 'Name',
    department: 'Department',
    job_title: 'Job title',
    view_movements: 'Movements',
    view_summary: 'Daily summary',
    show: 'Show',
    add_record: 'Add manual entry',
    note: 'Note',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    add_employee: 'Add employee',
    new_pin: 'New PIN (leave empty to keep)',
    pin_hint: '4 to 6 digits',
    import_title: 'Import employees from a file',
    import_hint: 'Excel or CSV with columns: emp_no, name, department, job_title, pin',
    choose_file: 'Choose file',
    template_xlsx: 'Excel template',
    template_csv: 'CSV template',
    active: 'Active',
    inactive: 'Suspended',
    deactivate: 'Suspend',
    activate: 'Activate',
    confirm_delete_emp: 'Deleting this employee permanently removes all their records. Continue?',
    confirm_delete_rec: 'Delete this entry?',
    export_title: 'Export reports',
    export_hint: 'The Excel file has two sheets: a daily summary (first in, last out, hours worked) and every movement.',
    today: 'Today',
    this_week: 'Last 7 days',
    this_month: 'This month',
    last_month: 'Last month',
    file_lang: 'File language',
    arabic: 'العربية',
    english: 'English',
    export_excel: 'Download Excel',
    export_csv: 'Movements CSV',
    export_csv_summary: 'Summary CSV',
    change_password: 'Change password',
    current_password: 'Current password',
    new_password: 'New password (min. 8 characters)',
    must_change: 'For security, change the default password now.',
    saved: 'Saved',
    deleted: 'Deleted',
    imported: 'Added: {added} • Updated: {updated} • Errors: {errors}',
    new_punch_in: '{name} checked in',
    new_punch_out: '{name} checked out',
    source_hr: 'Manual',
    rows_count: '{n} rows',
    connection_lost: 'Live connection lost, retrying…',
    err_missing_fields: 'Please fill in all required fields',
    err_invalid_credentials: 'Wrong employee number or PIN',
    err_too_many_attempts: 'Too many failed attempts. Try again in {s}s',
    err_inactive: 'Your account is suspended, please contact HR',
    err_already_in: 'You are already checked in since {since}',
    err_not_in: 'No open check-in found. Please check in first',
    err_invalid_pin: 'PIN must be 4 to 6 digits',
    err_emp_no_exists: 'This employee number is already used',
    err_employee_not_found: 'Employee not found',
    err_invalid_fields: 'Invalid data',
    err_password_too_short: 'Password too short (min. 8 characters)',
    err_wrong_password: 'Current password is wrong',
    err_missing_columns: 'The file needs at least emp_no and name columns',
    err_unreadable_file: 'Could not read the file',
    err_empty_file: 'The file is empty',
    err_file_too_large: 'File is too large',
    err_network: 'Cannot reach the server, check your connection',
    err_server_error: 'Server error',
    err_unauthorized: 'Session expired, please sign in again',
  },
};

function getLang() {
  try { return localStorage.getItem('lang') || 'ar'; } catch { return 'ar'; }
}

function t(key, vars = {}) {
  const dict = I18N[getLang()] || I18N.ar;
  let s = dict[key] ?? I18N.ar[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

function errorText(data) {
  const code = data && data.error ? data.error : 'server_error';
  return t('err_' + code, { s: data?.retry_after ?? '', since: data?.since ?? '' });
}

function applyI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-lang-toggle]').forEach((el) => { el.textContent = lang === 'ar' ? 'EN' : 'ع'; });
}

function toggleLang() {
  try { localStorage.setItem('lang', getLang() === 'ar' ? 'en' : 'ar'); } catch {}
  applyI18n();
  document.dispatchEvent(new Event('langchange'));
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer) && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({ ok: false, error: 'server_error' }));
    return { status: res.status, ...data };
  } catch {
    return { ok: false, error: 'network' };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  document.querySelectorAll('[data-lang-toggle]').forEach((el) => el.addEventListener('click', toggleLang));
});

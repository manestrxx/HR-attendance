// server.js — نقطة التشغيل: نسترجع البيانات من Turso أولًا ثم نشغّل التطبيق
const cloud = require('./lib/cloud');

cloud.prepare()
  .then(() => require('./app'))
  .catch((e) => {
    console.error('[startup] failed:', e);
    process.exit(1);
  });

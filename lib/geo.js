// lib/geo.js — حساب المسافة بين نقطتين (بالمتر) والتحقق من موقع العمل
const { db } = require('./db');

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const activeSites = () => db.prepare('SELECT * FROM sites WHERE active = 1').all();
const MAX_ACCURACY_BUFFER = 50; // نسمح بهامش دقة GPS حتى 50 مترًا

/**
 * يتحقق من موقع الموظف.
 * يعيد { ok, site, distance } أو { ok:false, error, ... }
 */
function checkLocation(emp, pos) {
  const sites = activeSites();
  const hasPos = pos && validCoord(pos.lat, pos.lng);
  const nearest = (list) => list
    .map((s) => ({ site: s, distance: distanceMeters(pos.lat, pos.lng, s.lat, s.lng) }))
    .sort((a, b) => a.distance - b.distance)[0];

  // لا توجد مواقع مفعّلة، أو الموظف مستثنى: لا قيود
  if (!sites.length || emp.geo_mode === 'exempt') {
    const n = hasPos && sites.length ? nearest(sites) : null;
    return { ok: true, site: n && n.distance <= n.site.radius ? n.site : null, distance: n ? n.distance : null };
  }
  if (!hasPos) return { ok: false, error: 'location_required' };
  const accuracy = Number.isFinite(pos.accuracy) ? pos.accuracy : 0;
  if (accuracy > 1000) return { ok: false, error: 'location_inaccurate' };

  let allowed = sites;
  if (emp.geo_mode === 'assigned') {
    const ids = new Set(db.prepare('SELECT site_id FROM employee_sites WHERE employee_id = ?').all(emp.id).map((r) => r.site_id));
    allowed = sites.filter((s) => ids.has(s.id));
    if (!allowed.length) return { ok: false, error: 'no_site_assigned' };
  }
  const n = nearest(allowed);
  const buffer = Math.min(accuracy, MAX_ACCURACY_BUFFER);
  if (n.distance - buffer <= n.site.radius) return { ok: true, site: n.site, distance: n.distance };
  return { ok: false, error: 'outside_zone', distance: Math.round(n.distance), site_name: n.site.name };
}

module.exports = { distanceMeters, validCoord, checkLocation, activeSites };

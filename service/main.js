// anka-tv service: runs inside TizenBrew's Node.js on the TV, without browser CORS limits.
// Plain ES5 on purpose: the TV's Node is v12, and TizenBrew mentions TVs with far older ones.
// service.js loads this file and passes in require, tizen, exports, shared (state kept across reloads) and reloadService.
//
//   GET /streams?language=tr&limit=24   live streams, most watched first (language optional)
//   GET /channels?slugs=a,b             channel info and live status, in the given order
//   GET /master.m3u8?slug=X             the channel's master playlist, with CORS open
//   POST /log, GET /log                 page log lines (readable from the Mac: http://<tv ip>:8090/log)
//   POST /cmd, GET /cmd                 a command for the page, e.g. "play zeitnot" (the Mac can drive the app)
//   POST /notify, GET /notify           a toast for the page: JSON {"text": "...", "sound": true}
//   GET /favourites, POST /favourites   the favourite slugs (JSON array), saved on the TV; shared by the page and the dashboard
//   GET /settings, POST /settings       app settings (JSON object, merged), e.g. {"theme": "ocean"}
//   GET /apps, POST /launch?id=X        installed TV apps from a known list, and launching one
//   GET /weather, POST /city            current weather for the saved city; POST a city name to set it
//   POST /state, GET /state             what the page shows now (grid or player, channel, quality, version)
//   GET /                               the web dashboard, for a phone or the Mac: http://<tv ip>:8090/
//   POST /reload-service                load the newest published version of this file (after tools/publish.sh)
//   GET /bosses, POST /boss-test        upcoming Black Desert (EU) boss spawns; send the next one's alert now
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var os = require('os');
var url = require('url');

// Not 8085: the spike module's service may still hold it until TizenBrew restarts.
var PORT = 8090;
// tools/publish.sh writes the published version here.
var SERVICE_VERSION = '0.32.0 (4a4a948)';
var UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 TV Safari/537.36';
var CACHE_MS = 20000;
// TizenBrew keeps its own config in /home/owner/share; tools/dev.sh points these elsewhere on the Mac.
var DATA_FILE = (process.env.ANKA_DATA_DIR || '/home/owner/share') + '/anka-tv.json';
// From the same commit as this file (service.js sets shared.base).
var DASHBOARD_URL = (shared.base || 'https://cdn.jsdelivr.net/gh/ANKA-CORP/anka-tv-module@main/') + 'dashboard/index.html';
var cache = {};
var logLines = shared.logLines;
var commands = [];
var notifications = [];
var pageState = null;

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { log('service: saving ' + DATA_FILE + ' failed: ' + e); }
}

// Well-known Samsung app IDs; /apps keeps those installed on this TV. Colours are for our own tiles.
var APP_CATALOGUE = [
  { id: '111299001912', name: 'YouTube', color: '#ff0033' },
  { id: '3201907018807', name: 'Netflix', color: '#e50914' },
  { id: '3201910019365', name: 'Prime Video', color: '#1a98ff' },
  { id: '3201901017640', name: 'Disney+', color: '#113ccf' },
  { id: '3201807016597', name: 'Apple TV', color: '#3a3a3c' },
  { id: '3201606009684', name: 'Spotify', color: '#1db954' },
  { id: '3202010022079', name: 'İnternet', color: '#5b5bd6' }
];
// The TV's own app API; on the Mac (tools/dev.sh) it's unset and launching only logs.
// Called on the TV's network address: from 127.0.0.1 the TV answers launches with 401 (tried 2026-10-20).
var TV_API = process.env.ANKA_DEV_DIR ? null : '/api/v2/applications/';

function lanAddress() {
  var nets = os.networkInterfaces();
  for (var name in nets) {
    for (var i = 0; i < nets[name].length; i++) {
      var n = nets[name][i];
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

// Spoken over a plain socket: the TV's HTTP answers trip Node 12.4's strict parser ("Parse Error").
function tvApi(method, id, cb) {
  var host = lanAddress();
  var done = false;
  var data = '';
  var sock = net.connect(8001, host, function () {
    sock.write(method + ' ' + TV_API + id + ' HTTP/1.0\r\nHost: ' + host + ':8001\r\nContent-Length: 0\r\n\r\n');
  });
  var once = function (err, status, body) {
    if (done) return;
    done = true;
    sock.destroy();
    cb(err, status, body);
  };
  sock.setEncoding('utf8');
  sock.setTimeout(8000, function () { once(new Error('timeout')); });
  sock.on('data', function (c) { data += c; });
  sock.on('end', function () {
    var m = /^HTTP\/1\.[01] (\d{3})/.exec(data);
    var at = data.indexOf('\r\n\r\n');
    if (!m) return once(new Error('unexpected answer: ' + data.slice(0, 80)));
    once(null, Number(m[1]), at >= 0 ? data.slice(at + 4) : '');
  });
  sock.on('error', function (e) { once(e); });
}

function installedApps(cb) {
  if (!TV_API) return cb(APP_CATALOGUE);
  var hit = cache.apps;
  if (hit && Date.now() - hit.at < 600000) return cb(hit.data);
  var found = [];
  var left = APP_CATALOGUE.length;
  APP_CATALOGUE.forEach(function (app, i) {
    tvApi('GET', app.id, function (err, status) {
      if (!err && status === 200) found[i] = app;
      if (--left === 0) {
        var list = found.filter(function (a) { return a; });
        cache.apps = { at: Date.now(), data: list };
        cb(list);
      }
    });
  });
}

// Weather from Open-Meteo (no key) for the city saved in settings (lat/lon from its geocoder).
function weather(cb) {
  var s = readData().settings || {};
  if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return cb(null, null);
  getJson('https://api.open-meteo.com/v1/forecast?latitude=' + s.lat + '&longitude=' + s.lon +
    '&current=temperature_2m,weather_code,is_day&timezone=auto', function (err, w) {
    if (err) return cb(err);
    cb(null, { city: s.city, temp: Math.round(w.current.temperature_2m), code: w.current.weather_code, day: w.current.is_day === 1 });
  });
}

function geocode(name, cb) {
  getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=tr&name=' + encodeURIComponent(name), function (err, r) {
    if (err) return cb(err);
    var g = r.results && r.results[0];
    cb(null, g ? { city: g.name, lat: g.latitude, lon: g.longitude } : null);
  });
}

// On the TV the dashboard comes from the published module; on the Mac from the working copy.
function dashboardHtml(cb) {
  if (process.env.ANKA_DEV_DIR) {
    return fs.readFile(process.env.ANKA_DEV_DIR + '/dashboard/index.html', 'utf8', cb);
  }
  var hit = cache[DASHBOARD_URL];
  if (hit && Date.now() - hit.at < 60000) return cb(null, hit.data);
  get(DASHBOARD_URL, function (err, body, status) {
    if (err || status !== 200) return cb(err || new Error('HTTP ' + status));
    cache[DASHBOARD_URL] = { at: Date.now(), data: body };
    cb(null, body);
  });
}

function get(target, cb) {
  https.get(target, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(chunks).toString(), res.statusCode); });
  }).on('error', function (e) { cb(e); });
}

function getJson(target, cb) {
  var hit = cache[target];
  if (hit && Date.now() - hit.at < CACHE_MS) return cb(null, hit.data);
  get(target, function (err, body, status) {
    if (err || status !== 200) return cb(err || new Error('HTTP ' + status + ' from ' + target));
    var data;
    try { data = JSON.parse(body); } catch (e) { return cb(e); }
    cache[target] = { at: Date.now(), data: data };
    cb(null, data);
  });
}

// Kick's thumbnail srcset: "url 1920w, url 1280w, ...". Picks the smallest at least `width` wide.
function pick(thumbnail, width) {
  if (!thumbnail) return '';
  var sizes = (thumbnail.srcset || '').split(',').map(function (part) {
    var m = part.trim().match(/^(\S+)\s+(\d+)w$/);
    return m ? { url: m[1], w: parseInt(m[2], 10) } : null;
  }).filter(function (s) { return s; }).sort(function (a, b) { return a.w - b.w; });
  if (!sizes.length) return thumbnail.src || '';
  var fit = sizes.filter(function (s) { return s.w >= width; })[0];
  return (fit || sizes[sizes.length - 1]).url;
}

// One shape for every stream the page shows.
function fromListItem(s) {
  return {
    slug: s.channel.slug,
    name: s.channel.username,
    avatar: s.channel.profile_pic || '',
    live: true,
    title: s.title || '',
    viewers: s.viewer_count || 0,
    thumb: pick(s.thumbnail, 640),
    hero: pick(s.thumbnail, 1920),
    category: s.category ? s.category.name : '',
    startedAt: s.start_time || ''
  };
}

// `c` is /api/v2/channels/<slug>; `live` its /livestream (the channel's own thumbnail URL answers 403).
function fromChannel(slug, c, live) {
  var l = c.livestream;
  var thumbnail = live && live.data ? live.data.thumbnail : null;
  return {
    slug: c.slug || slug,
    name: c.user ? c.user.username : slug,
    avatar: c.user && c.user.profile_pic ? c.user.profile_pic : '',
    live: !!(l && l.is_live !== false),
    title: l ? l.session_title || '' : '',
    viewers: l ? l.viewer_count || 0 : 0,
    thumb: pick(thumbnail, 640),
    hero: pick(thumbnail, 1920),
    category: l && l.categories && l.categories[0] ? l.categories[0].name : '',
    startedAt: l && l.start_time ? l.start_time.replace(' ', 'T') + 'Z' : '',
    offlineImage: c.offline_banner_image ? c.offline_banner_image.src || '' : ''
  };
}

function channelInfo(slug, cb) {
  var base = 'https://kick.com/api/v2/channels/' + encodeURIComponent(slug);
  getJson(base, function (err, c) {
    if (err) return cb(err);
    if (!c.livestream) return cb(null, fromChannel(slug, c, null));
    getJson(base + '/livestream', function (err2, live) { cb(null, fromChannel(slug, c, err2 ? null : live)); });
  });
}

function log(line) {
  logLines.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (logLines.length > 500) logLines.shift();
}

function reply(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

function replyJson(res, data) {
  reply(res, 200, 'application/json', JSON.stringify(data));
}

function fail(res, what, err) {
  log('service: ' + what + ' failed: ' + err);
  reply(res, 502, 'text/plain', what + ' failed: ' + err);
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () { cb(body); });
}

// A queue the page drains: GET returns everything pending as a JSON array.
function queue(req, res, list, parse) {
  if (req.method === 'POST') {
    return readBody(req, function (b) {
      var item = parse(b);
      if (item === null) return reply(res, 400, 'text/plain', 'bad body');
      list.push(item);
      log('from Mac: ' + b.trim());
      reply(res, 204, 'text/plain', '');
    });
  }
  replyJson(res, list.splice(0, list.length));
}

// ---- Black Desert boss alerts (EU). The schedule comes from MMOTIMER's page: Garmoth answers scripts with a
// Cloudflare challenge. Its "spawns in" column avoids guessing which time zone the page's clock column is in.
var BOSS_URL = 'https://mmotimer.com/bdo/?server=eu';
var BOSS_ALERT_MS = 20 * 60000;
var bossCache = null;
var bossAlerted = shared.bossAlerted || (shared.bossAlerted = {});

function bossImage(name) {
  var file = name === 'Golden Pig King' ? 'pig' : name.toLowerCase().replace(/[^a-z]+/g, '_');
  return 'https://mmotimer.com/img/' + file + '_big.png';
}

// Table rows look like: "Kzarka, Kutum" | "00:15 Wednesday" | "02:37:35".
function parseBosses(html, now) {
  var at = html.indexOf('id="mainTbl"');
  if (at < 0) return [];
  var rows = html.slice(at, html.indexOf('</table>', at)).match(/<tr[\s\S]*?<\/tr>/g) || [];
  var spawns = [];
  rows.forEach(function (r) {
    var cells = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(function (c) {
      return c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    });
    var left = cells.length >= 3 && /^(\d+):(\d\d):(\d\d)$/.exec(cells[2]);
    if (!left) return;
    var ms = ((+left[1]) * 3600 + (+left[2]) * 60 + (+left[3])) * 1000;
    spawns.push({
      // Spawns are on the minute; rounding drops the seconds the page took to arrive.
      at: Math.round((now + ms) / 60000) * 60000,
      bosses: cells[0].split(',').map(function (n) { return n.trim(); }).filter(function (n) { return n; })
        .map(function (n) { return { name: n, image: bossImage(n) }; })
    });
  });
  return spawns;
}

function bosses(cb) {
  if (bossCache && Date.now() - bossCache.fetched < 30 * 60000 && bossCache.spawns.length) {
    return cb(null, bossCache.spawns.filter(function (s) { return s.at > Date.now(); }));
  }
  get(BOSS_URL, function (err, html, status) {
    if (err || status !== 200) return cb(err || new Error('HTTP ' + status + ' from ' + BOSS_URL));
    var spawns = parseBosses(html, Date.now());
    if (!spawns.length) return cb(new Error('no boss rows in ' + BOSS_URL));
    bossCache = { fetched: Date.now(), spawns: spawns };
    cb(null, spawns.filter(function (s) { return s.at > Date.now(); }));
  });
}

function bossNotice(spawn, test) {
  return {
    kind: 'boss',
    at: spawn.at,
    bosses: spawn.bosses,
    text: spawn.bosses.map(function (b) { return b.name; }).join(', '),
    sound: true,
    test: !!test
  };
}

// Every half minute: queue an alert for each spawn that is now 20 minutes or less away, once.
function checkBosses() {
  var settings = readData().settings || {};
  if (settings.bossAlerts === false) return;
  bosses(function (err, spawns) {
    if (err) return log('service: bosses ' + err);
    spawns.forEach(function (s) {
      var key = String(s.at);
      if (s.at - Date.now() > BOSS_ALERT_MS || bossAlerted[key]) return;
      bossAlerted[key] = true;
      notifications.push(bossNotice(s));
      log('boss alert: ' + bossNotice(s).text + ' at ' + new Date(s.at).toISOString().slice(11, 16) + ' UTC');
    });
  });
}
var bossTimer = setInterval(checkBosses, 30000);

function handle(req, res) {
  var u = url.parse(req.url, true);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (u.pathname === '/reload-service' && req.method === 'POST') {
    log('service: reloading');
    reply(res, 202, 'text/plain', 'reloading');
    return setTimeout(reloadService, 100);
  }
  if (u.pathname === '/bosses') {
    return bosses(function (err, spawns) {
      if (err) return fail(res, 'bosses', err);
      replyJson(res, spawns.slice(0, 12));
    });
  }
  if (u.pathname === '/boss-test' && req.method === 'POST') {
    return bosses(function (err, spawns) {
      if (err || !spawns.length) return fail(res, 'boss test', err || 'no spawns');
      notifications.push(bossNotice(spawns[0], true));
      replyJson(res, bossNotice(spawns[0], true));
    });
  }
  if (u.pathname === '/log') {
    if (req.method === 'POST') return readBody(req, function (b) { log(b); reply(res, 204, 'text/plain', ''); });
    return reply(res, 200, 'text/plain', logLines.join('\n') + '\n');
  }
  if (u.pathname === '/' || u.pathname === '/dashboard') {
    return dashboardHtml(function (err, html) {
      if (err) return fail(res, 'dashboard', err);
      reply(res, 200, 'text/html; charset=utf-8', html);
    });
  }
  if (u.pathname === '/favourites') {
    if (req.method === 'POST') {
      return readBody(req, function (b) {
        var list;
        try { list = JSON.parse(b); } catch (e) { list = null; }
        if (!Array.isArray(list)) return reply(res, 400, 'text/plain', 'expected a JSON array of slugs');
        var data = readData();
        data.favourites = list.filter(function (s) { return typeof s === 'string' && /^[\w-]{1,40}$/.test(s); });
        writeData(data);
        log('favourites: ' + data.favourites.join(', '));
        replyJson(res, { favourites: data.favourites });
      });
    }
    // null until the first save, so the page can seed it from what it had before.
    var saved = readData().favourites;
    return replyJson(res, { favourites: Array.isArray(saved) ? saved : null });
  }
  if (u.pathname === '/apps') return installedApps(function (list) { replyJson(res, list); });
  if (u.pathname === '/launch' && req.method === 'POST') {
    var app = APP_CATALOGUE.filter(function (a) { return a.id === u.query.id; })[0];
    if (!app) return reply(res, 400, 'text/plain', 'unknown app');
    log('launch ' + app.name);
    if (!TV_API) return replyJson(res, { launched: false, dev: true });
    return tvApi('POST', app.id, function (err, status) {
      if (err || status !== 200) return fail(res, 'launch ' + app.name, err || status);
      replyJson(res, { launched: true });
    });
  }
  if (u.pathname === '/weather') {
    return weather(function (err, w) {
      if (err) return fail(res, 'weather', err);
      replyJson(res, w);
    });
  }
  if (u.pathname === '/city' && req.method === 'POST') {
    return readBody(req, function (b) {
      geocode(b.trim(), function (err, g) {
        if (err) return fail(res, 'geocode', err);
        if (!g) return reply(res, 404, 'text/plain', 'city not found');
        var data = readData();
        data.settings = data.settings || {};
        data.settings.city = g.city; data.settings.lat = g.lat; data.settings.lon = g.lon;
        writeData(data);
        log('city: ' + g.city);
        replyJson(res, g);
      });
    });
  }
  if (u.pathname === '/settings') {
    if (req.method === 'POST') {
      return readBody(req, function (b) {
        var patch;
        try { patch = JSON.parse(b); } catch (e) { patch = null; }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return reply(res, 400, 'text/plain', 'expected a JSON object');
        var data = readData();
        data.settings = data.settings || {};
        Object.keys(patch).forEach(function (k) {
          // Settings are flat: short strings, numbers or booleans.
          var v = patch[k];
          if (/^\w{1,30}$/.test(k) && (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 60))) data.settings[k] = v;
        });
        writeData(data);
        log('settings: ' + JSON.stringify(data.settings));
        replyJson(res, data.settings);
      });
    }
    return replyJson(res, readData().settings || {});
  }
  if (u.pathname === '/state') {
    if (req.method === 'POST') {
      return readBody(req, function (b) {
        try { pageState = JSON.parse(b); pageState.at = Date.now(); } catch (e) {}
        reply(res, 204, 'text/plain', '');
      });
    }
    return replyJson(res, pageState ? { state: pageState, ageSeconds: Math.round((Date.now() - pageState.at) / 1000) } : { state: null });
  }
  if (u.pathname === '/cmd') return queue(req, res, commands, function (b) { return b.trim() || null; });
  if (u.pathname === '/notify') {
    return queue(req, res, notifications, function (b) {
      try { var n = JSON.parse(b); return n && n.text ? n : null; } catch (e) { return b.trim() ? { text: b.trim() } : null; }
    });
  }
  if (u.pathname === '/streams') {
    var limit = Math.min(parseInt(u.query.limit, 10) || 24, 50);
    var target = 'https://web.kick.com/api/v1/livestreams?limit=' + limit + '&sort=viewer_count_desc' +
      (u.query.language ? '&language=' + encodeURIComponent(u.query.language) : '');
    return getJson(target, function (err, data) {
      if (err) return fail(res, 'streams', err);
      try { replyJson(res, data.data.livestreams.map(fromListItem)); } catch (e) { fail(res, 'streams parse', e); }
    });
  }
  if (u.pathname === '/channels') {
    var slugs = (u.query.slugs || '').split(',').filter(function (s) { return s; });
    var out = new Array(slugs.length);
    var left = slugs.length;
    if (!left) return replyJson(res, []);
    slugs.forEach(function (slug, i) {
      channelInfo(slug, function (err, info) {
        // A missing or failing channel still gets a card, shown as offline.
        out[i] = err ? { slug: slug, name: slug, avatar: '', live: false, title: '', viewers: 0, thumb: '', hero: '', category: '', startedAt: '' } : info;
        if (err) log('service: channel ' + slug + ': ' + err);
        if (--left === 0) replyJson(res, out);
      });
    });
    return;
  }
  if (u.pathname === '/master.m3u8') {
    return get('https://kick.com/api/v2/channels/' + encodeURIComponent(u.query.slug) + '/playback-url', function (err, body, status) {
      if (err || status !== 200) return fail(res, 'playback-url', err || status);
      var playback;
      try { playback = JSON.parse(body).data; } catch (e) { return fail(res, 'playback parse', e); }
      get(playback, function (err2, m3u8, status2) {
        if (err2 || status2 !== 200) return fail(res, 'master', err2 || status2);
        reply(res, 200, 'application/vnd.apple.mpegurl', m3u8);
      });
    });
  }
  reply(res, 404, 'text/plain', 'not found');
}

// An exception here would take down TizenBrew's whole service process, so a bad request only gets a 500.
var sockets = [];
var server = http.createServer(function (req, res) {
  try { handle(req, res); } catch (e) {
    log('service: ' + req.url + ' threw ' + (e && e.stack || e));
    try { reply(res, 500, 'text/plain', 'error'); } catch (e2) {}
  }
}).on('connection', function (s) {
  sockets.push(s);
  s.on('close', function () { sockets.splice(sockets.indexOf(s), 1); });
}).on('error', function (e) {
  // Without a handler a busy port would take down TizenBrew's whole service process with it.
  log('service: ' + e);
}).listen(PORT, '0.0.0.0');

// Called by service.js before it loads a newer version: free the port, drop the page's keep-alive connections.
exports.stop = function (done) {
  clearInterval(bossTimer);
  server.close(function () { done(); });
  sockets.slice().forEach(function (s) { s.destroy(); });
};

log('service ' + SERVICE_VERSION + ' started on port ' + PORT + ', node ' + process.version + ', tizen ' + typeof tizen);

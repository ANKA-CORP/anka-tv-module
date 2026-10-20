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
//   GET /tizen-apps                     every installed app as Tizen sees it (id, name, package, icon path)
//   GET /weather, POST /city            current weather for the saved city; POST a city name to set it
//   POST /state, GET /state             what the page shows now (grid or player, channel, quality, version)
//   GET /                               the web dashboard, for a phone or the Mac: http://<tv ip>:8090/
//   GET /auth/status, POST /auth/login, POST /auth/logout, POST /auth/set   the dashboard's password (see below)
//   POST /reload-service                load the newest published version of this file (after tools/publish.sh)
//   GET /events                         server-sent events for open dashboards: settings, favourites, state, notice
//   GET /bosses, POST /boss-test        upcoming Black Desert (EU) boss spawns; send the next one's alert now
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var os = require('os');
var tls = require('tls');
var url = require('url');

// Not 8085: the spike module's service may still hold it until TizenBrew restarts.
var PORT = Number(process.env.ANKA_PORT) || 8090;   // another port only in tools/test.sh
// tools/publish.sh writes the published version here.
var SERVICE_VERSION = '0.48.0 (a97be2b)';
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

// ---- live updates for every open dashboard (server-sent events): what one screen changes, the others see at once.
var listeners = [];

function broadcast(event, data) {
  var msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  listeners.forEach(function (res) { res.write(msg); });
}

function subscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
  res.write('retry: 3000\n\n');
  listeners.push(res);
  req.on('close', function () { listeners.splice(listeners.indexOf(res), 1); });
}

// Proxies and phones drop quiet connections; a comment every 25 s keeps them open.
var pingTimer = setInterval(function () { listeners.forEach(function (res) { res.write(': ping\n\n'); }); }, 25000);

// Every notice for the TV page goes through here, so dashboards show it too.
function notify(n) {
  notifications.push(n);
  broadcast('notice', n);
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { log('service: saving ' + DATA_FILE + ' failed: ' + e); }
}

// Well-known Samsung app IDs; /apps keeps those installed on this TV. Colours are for our own tiles.
var APP_CATALOGUE = [
  // YouTube's icon on the TV is Tizen's generic placeholder and Prime Video's file is missing: their sites' icons instead.
  { id: '111299001912', tizen: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube', color: '#ff0033', noIcon: true, web: 'www.youtube.com' },
  { id: '3201907018807', tizen: 'org.tizen.netflix-app', name: 'Netflix', color: '#e50914' },
  { id: '3201910019365', tizen: 'org.tizen.primevideo', name: 'Prime Video', color: '#1a98ff', web: 'www.primevideo.com' },
  { id: '3201901017640', tizen: 'MCmYXNxgcu.DisneyPlus', name: 'Disney+', color: '#113ccf' },
  { id: '3201807016597', tizen: 'com.samsung.tv.aria-video', name: 'Apple TV', color: '#3a3a3c' },
  { id: '3201606009684', tizen: 'rJeHak5zRg.Spotify', name: 'Spotify', color: '#1db954' },
  { id: '3202010022079', tizen: 'org.tizen.browser', name: 'İnternet', color: '#5b5bd6' }
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
  // On the Mac: the whole catalogue, with the web icons.
  if (!TV_API) return cb(APP_CATALOGUE.map(function (app) {
    return app.web ? { id: app.id, name: app.name, color: app.color, icon: '/app-icon?id=' + app.id } : app;
  }));
  tizenApps(function (err, list) {
    if (err) return installedFromRest(cb);
    cb(APP_CATALOGUE.map(function (app) {
      var t = tizenAppFor(app, list);
      if (!t) return null;
      var a = { id: app.id, name: app.name, color: app.color };
      if ((t.iconPath && !app.noIcon && fs.existsSync(t.iconPath)) || app.web) a.icon = '/app-icon?id=' + app.id;
      return a;
    }).filter(function (a) { return a; }));
  });
}

function installedFromRest(cb) {
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

// ---- the TV's own remote-control channel (what the phone remote apps use), for keys apps can't send otherwise,
// like switching to an HDMI input. A tiny WebSocket client: Node 12 has none built in. The TV asks once on screen
// whether to allow "anka tv"; the token it then gives is kept in the data file.
function remoteSession(onReady) {
  var data = readData();
  var path = '/api/v2/channels/samsung.remote.control?name=' + Buffer.from('anka tv').toString('base64') +
    (data.remoteToken ? '&token=' + data.remoteToken : '');
  var sock = tls.connect({ host: '127.0.0.1', port: Number(process.env.ANKA_REMOTE_PORT) || 8002, rejectUnauthorized: false }, function () {
    sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:8002\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  var buf = Buffer.alloc(0);
  var upgraded = false;
  var done = false;
  var finish = function (err, msg) {
    if (done) return;
    done = true;
    onReady(err, msg, function send(obj) {
      var payload = Buffer.from(JSON.stringify(obj));
      var mask = crypto.randomBytes(4);
      var head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
      for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      sock.write(Buffer.concat([head, mask, payload]));
    }, function close() { sock.end(); });
  };
  sock.setTimeout(30000, function () { finish(new Error('no answer (allow "anka tv" on the TV?)')); sock.destroy(); });
  sock.on('error', function (e) { finish(e); });
  sock.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      var end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      var status = buf.slice(0, end).toString().split('\r\n')[0];
      if (!/ 101 /.test(status)) return finish(new Error('handshake: ' + status));
      upgraded = true;
      buf = buf.slice(end + 4);
    }
    // Frames from the TV aren't masked; text frames only, small ones.
    while (buf.length >= 2) {
      var len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      var text = buf.slice(off, off + len).toString();
      buf = buf.slice(off + len);
      var msg;
      try { msg = JSON.parse(text); } catch (e) { continue; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token) { var d = readData(); d.remoteToken = msg.data.token; writeData(d); }
        finish(null, msg);
      } else if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
        finish(new Error(msg.event));
      }
    }
  });
}

function remoteKey(key, cb) {
  remoteSession(function (err, msg, send, close) {
    if (err) return cb(err);
    send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
    setTimeout(close, 500);
    cb(null);
  });
}

// TizenBrew hands the service Tizen's device API (the page doesn't get it). Installed apps, cached for 10 minutes.
function tizenApps(cb) {
  if (typeof tizen === 'undefined' || !tizen || !tizen.application) return cb(new Error('no Tizen API'));
  var hit = cache.tizenApps;
  if (hit && Date.now() - hit.at < 600000) return cb(null, hit.data);
  try {
    tizen.application.getAppsInfo(function (list) {
      var data = list.map(function (a) { return { id: a.id, name: a.name, packageId: a.packageId, iconPath: a.iconPath }; });
      cache.tizenApps = { at: Date.now(), data: data };
      cb(null, data);
    }, function (e) { cb(new Error(e.name + ': ' + e.message)); });
  } catch (e) { cb(e); }
}

// An app's icon from its website (Google's favicon service), fetched at runtime and kept in memory.
function webIcon(domain, cb) {
  var key = 'icon:' + domain;
  if (cache[key]) return cb(null, cache[key]);
  https.get('https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://' + domain + '&size=256', function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode + ' for the ' + domain + ' icon'));
      cache[key] = Buffer.concat(chunks);
      cb(null, cache[key]);
    });
  }).on('error', cb);
}

function plain(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// The catalogue names each app's Tizen id (its store id is what the REST API takes); the name is the fallback.
function tizenAppFor(app, list) {
  return list.filter(function (a) { return a.id === app.tizen; })[0] ||
    list.filter(function (a) { return plain(a.name) === plain(app.name); })[0] || null;
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
      if (list === notifications) notify(item); else list.push(item);
      log('from Mac: ' + b.trim());
      reply(res, 204, 'text/plain', '');
    });
  }
  replyJson(res, list.splice(0, list.length));
}

// ---- favourites going live: every 2 minutes, a toast for each favourite that started streaming since the last look.
var wasLive = shared.wasLive || (shared.wasLive = {});

// Channels that are live now and were seen offline before. The first look at a channel only learns its state,
// so a restart doesn't announce everyone who is already live.
function newlyLive(seen, channels) {
  return channels.filter(function (c) {
    var before = seen[c.slug];
    seen[c.slug] = !!c.live;
    return before === false && c.live;
  });
}

function checkLive() {
  var data = readData();
  var slugs = data.favourites || [];
  if ((data.settings || {}).liveAlerts === false || !slugs.length) return;
  var found = [];
  var left = slugs.length;
  slugs.forEach(function (slug) {
    channelInfo(slug, function (err, c) {
      if (!err) found.push(c);
      if (--left) return;
      newlyLive(wasLive, found).forEach(function (c) {
        notify({ kind: 'live', title: 'Yayına başladı', text: c.name + (c.title ? ' · ' + c.title : ''),
          avatar: c.avatar, slug: c.slug, sound: true, seconds: 10 });
        log('live alert: ' + c.slug);
      });
    });
  });
}
var liveTimer = setInterval(checkLive, 120000);
setTimeout(checkLive, 5000);

// ---- Black Desert boss alerts (EU). The schedule comes from MMOTIMER's page: Garmoth answers scripts with a
// Cloudflare challenge. Its weekly grid holds every spawn (the "upcoming" list skips the next one, shown apart).
var BOSS_URL = 'https://mmotimer.com/bdo/?server=eu';
var BOSS_ALERT_MS = 5 * 60000;
var WEEK_MIN = 7 * 1440;
var DAYS = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
var bossCache = null;
var bossAlerted = shared.bossAlerted || (shared.bossAlerted = {});

function bossImage(name) {
  var file = name === 'Golden Pig King' ? 'pig' : name.toLowerCase().replace(/[^a-z]+/g, '_');
  return 'https://mmotimer.com/img/' + file + '_big.png';
}

// Minutes since Sunday 00:00 UTC.
function weekMinute(ms) {
  var d = new Date(ms);
  return d.getUTCDay() * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes();
}

// The grid is in the page's own time zone (Berlin time, though it says CET). The upcoming list pairs a clock time
// ("00:15 Wednesday") with a countdown ("02:37:35"); the two give the zone's offset, summer time included.
function pageOffset(html, now) {
  var at = html.indexOf('id="mainTbl"');
  if (at < 0) return null;
  var rows = html.slice(at, html.indexOf('</table>', at)).match(/<tr[\s\S]*?<\/tr>/g) || [];
  for (var i = 0; i < rows.length; i++) {
    var cells = (rows[i].match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(function (c) {
      return c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    });
    var clock = cells.length >= 3 && /^(\d\d):(\d\d) (\w+day)$/.exec(cells[1]);
    var left = clock && /^(\d+):(\d\d):(\d\d)$/.exec(cells[2]);
    if (!left || DAYS[clock[3]] === undefined) continue;
    var spawn = now + ((+left[1]) * 3600 + (+left[2]) * 60 + (+left[3])) * 1000;
    var local = DAYS[clock[3]] * 1440 + (+clock[1]) * 60 + (+clock[2]);
    var diff = ((local - weekMinute(spawn)) % WEEK_MIN + WEEK_MIN) % WEEK_MIN;
    if (diff > WEEK_MIN / 2) diff -= WEEK_MIN;
    return Math.round(diff / 15) * 15;
  }
  return null;
}

// The grid: a header row of times, then one row per day ("Tue") with a cell per time, bosses split by <br>.
// The time comes from the column, not the cells' ids: one id is wrong on the page (12:00 says 14:00).
function parseBosses(html, now) {
  var offset = pageOffset(html, now);
  var at = html.indexOf('class="table main-table"');
  if (offset === null || at < 0) return [];
  var rows = html.slice(at, html.indexOf('</table>', at)).match(/<tr[\s\S]*?<\/tr>/g) || [];
  var times = (rows[0] || '').match(/\d\d:\d\d/g) || [];
  var nowMin = Math.floor(now / 60000);
  var spawns = [];
  rows.slice(1).forEach(function (r) {
    var day = /<th[^>]*>\s*(\w{3})\s*<\/th>/.exec(r);
    var dayIndex = day ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day[1]) : -1;
    if (dayIndex < 0) return;
    (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).forEach(function (c, col) {
      var names = c.replace(/<\/td>$/, '').split(/<br\s*\/?>/).map(function (n) { return n.replace(/<[^>]+>/g, '').trim(); })
        .filter(function (n) { return n && n !== '-'; });
      var hm = times[col] && /^(\d\d):(\d\d)$/.exec(times[col]);
      if (!names.length || !hm) return;
      var utc = dayIndex * 1440 + (+hm[1]) * 60 + (+hm[2]) - offset;
      var ahead = ((utc - weekMinute(now)) % WEEK_MIN + WEEK_MIN) % WEEK_MIN;
      spawns.push({ at: (nowMin + ahead) * 60000, bosses: names.map(function (n) { return { name: n, image: bossImage(n) }; }) });
    });
  });
  return spawns.sort(function (x, y) { return x.at - y.at; });
}

function bosses(cb) {
  if (bossCache && Date.now() - bossCache.fetched < 30 * 60000 && bossCache.spawns.length) {
    return cb(null, bossCache.spawns.filter(function (s) { return s.at > Date.now(); }));
  }
  // tools/test.sh feeds a saved copy of the page.
  if (process.env.ANKA_BOSS_FILE) return fs.readFile(process.env.ANKA_BOSS_FILE, 'utf8', function (err, html) { useBossPage(err, html, 200, cb); });
  get(BOSS_URL, function (err, html, status) { useBossPage(err, html, status, cb); });
}

function useBossPage(err, html, status, cb) {
  if (err || status !== 200) return cb(err || new Error('HTTP ' + status + ' from ' + BOSS_URL));
  var spawns = parseBosses(html, Date.now());
  if (!spawns.length) return cb(new Error('no boss rows in ' + BOSS_URL));
  bossCache = { fetched: Date.now(), spawns: spawns };
  cb(null, spawns.filter(function (s) { return s.at > Date.now(); }));
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

// Every half minute: queue an alert for each spawn that is now 5 minutes or less away, once.
function checkBosses() {
  var settings = readData().settings || {};
  if (settings.bossAlerts === false) return;
  bosses(function (err, spawns) {
    if (err) return log('service: bosses ' + err);
    spawns.forEach(function (s) {
      var key = String(s.at);
      if (s.at - Date.now() > BOSS_ALERT_MS || bossAlerted[key]) return;
      bossAlerted[key] = true;
      notify(bossNotice(s));
      log('boss alert: ' + bossNotice(s).text + ' at ' + new Date(s.at).toISOString().slice(11, 16) + ' UTC');
    });
  });
}
var bossTimer = setInterval(checkBosses, 30000);

// ---- the dashboard's password. Only a salted scrypt hash is kept on the TV; tools/set_dashboard_password.py sends
// the password from Kaan's .env. Logging in gives a session cookie; the script gets a token for agents on the Mac.
// The TV's own page (127.0.0.1) never needs either. Until a password is set, everything stays open.
var SESSION_MS = 90 * 24 * 3600000;
var failures = {};

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function passwordMatches(auth, password) {
  var a = Buffer.from(hashPassword(password, auth.salt), 'hex');
  var b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newSession(data, kind, ms) {
  var token = crypto.randomBytes(24).toString('hex');
  data.sessions = data.sessions || {};
  var now = Date.now();
  Object.keys(data.sessions).forEach(function (t) { if (data.sessions[t].until < now) delete data.sessions[t]; });
  data.sessions[token] = { kind: kind, until: now + ms };
  return token;
}

function requestToken(req) {
  var bearer = /^Bearer\s+(\w+)$/.exec(req.headers.authorization || '');
  if (bearer) return bearer[1];
  var cookie = /(?:^|;\s*)anka_session=(\w+)/.exec(req.headers.cookie || '');
  return cookie ? cookie[1] : null;
}

function isLocal(req) {
  if (process.env.ANKA_NO_LOCAL_BYPASS) return false;   // tools/test.sh tests the password from 127.0.0.1
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function signedIn(req, data) {
  var token = requestToken(req);
  var s = token && data.sessions && data.sessions[token];
  return !!(s && s.until > Date.now());
}

function allowed(req) {
  if (isLocal(req)) return true;
  var data = readData();
  return !data.auth || signedIn(req, data);
}

function sessionCookie(token, ms) {
  return 'anka_session=' + token + '; Path=/; Max-Age=' + Math.round(ms / 1000) + '; HttpOnly; SameSite=Strict';
}

function handleAuth(req, res, u) {
  var data = readData();
  if (u.pathname === '/auth/status') return replyJson(res, { set: !!data.auth, signedIn: isLocal(req) || !data.auth || signedIn(req, data) });
  if (req.method !== 'POST') return reply(res, 405, 'text/plain', 'POST only');
  if (u.pathname === '/auth/logout') {
    var t = requestToken(req);
    if (t && data.sessions) { delete data.sessions[t]; writeData(data); }
    res.writeHead(204, { 'Set-Cookie': sessionCookie('x', 0) });
    return res.end();
  }
  readBody(req, function (b) {
    var body;
    try { body = JSON.parse(b); } catch (e) { body = {}; }
    var ip = req.socket.remoteAddress;
    if (u.pathname === '/auth/login') {
      var f = failures[ip];
      if (f && f.count >= 5 && Date.now() - f.at < 30000) return reply(res, 429, 'text/plain', 'too many tries, wait 30 s');
      if (!data.auth) return reply(res, 409, 'text/plain', 'no password set');
      if (!passwordMatches(data.auth, body.password || '')) {
        failures[ip] = { count: (f && Date.now() - f.at < 30000 ? f.count : 0) + 1, at: Date.now() };
        log('dashboard: wrong password from ' + ip);
        return reply(res, 401, 'text/plain', 'wrong password');
      }
      delete failures[ip];
      var token = newSession(data, 'browser', SESSION_MS);
      writeData(data);
      log('dashboard: signed in from ' + ip);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token, SESSION_MS) });
      return res.end('{"ok":true}');
    }
    if (u.pathname === '/auth/set') {
      // The first password can be set from the home network; changing it needs the current one or a token.
      if (data.auth && !signedIn(req, data) && !passwordMatches(data.auth, body.current || '')) return reply(res, 401, 'text/plain', 'not allowed');
      if (typeof body.password !== 'string' || body.password.length < 6) return reply(res, 400, 'text/plain', 'password: at least 6 characters');
      var salt = crypto.randomBytes(16).toString('hex');
      data.auth = { salt: salt, hash: hashPassword(body.password, salt) };
      data.sessions = {};   // a new password signs everyone out
      var agent = newSession(data, 'agent', 365 * 24 * 3600000);
      writeData(data);
      log('dashboard: password set from ' + ip);
      return replyJson(res, { ok: true, token: agent });
    }
    reply(res, 404, 'text/plain', 'not found');
  });
}

function handle(req, res) {
  var u = url.parse(req.url, true);
  if (u.pathname.indexOf('/auth/') === 0) return handleAuth(req, res, u);
  // On the Mac the dashboard's images come from the working copy, same-origin (CSS masks need CORS otherwise).
  if (process.env.ANKA_DEV_DIR && u.pathname.indexOf('/dev-app/img/') === 0 && !/\.\./.test(u.pathname)) {
    var file = process.env.ANKA_DEV_DIR + '/app/' + u.pathname.slice('/dev-app/'.length);
    var type = /\.svg$/.test(file) ? 'image/svg+xml' : /\.webp$/.test(file) ? 'image/webp' : 'image/png';
    return fs.readFile(file, function (err, data) { err ? reply(res, 404, 'text/plain', 'not found') : reply(res, 200, type, data); });
  }
  // The dashboard's page is public (it shows the login); everything it calls needs a session.
  if (u.pathname !== '/' && u.pathname !== '/dashboard' && req.method !== 'OPTIONS' && !allowed(req)) {
    return reply(res, 401, 'text/plain', 'sign in first');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (u.pathname === '/reload-service' && req.method === 'POST') {
    log('service: reloading');
    reply(res, 202, 'text/plain', 'reloading');
    return setTimeout(reloadService, 100);
  }
  if (u.pathname === '/events') return subscribe(req, res);
  if (u.pathname === '/bosses') {
    return bosses(function (err, spawns) {
      if (err) return fail(res, 'bosses', err);
      replyJson(res, spawns.slice(0, 12));
    });
  }
  if (u.pathname === '/boss-test' && req.method === 'POST') {
    return bosses(function (err, spawns) {
      if (err || !spawns.length) return fail(res, 'boss test', err || 'no spawns');
      notify(bossNotice(spawns[0], true));
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
      // Images (the painting, the marks) come from the app folder of the same version.
      var app = process.env.ANKA_DEV_DIR ? '/dev-app/'
        : (shared.base || 'https://cdn.jsdelivr.net/gh/ANKA-CORP/anka-tv-module@main/') + 'app/';
      reply(res, 200, 'text/html; charset=utf-8', html.replace(/%%APP%%/g, app));
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
        broadcast('favourites', data.favourites);
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
    // The REST API answers 401 to the TV itself, so Tizen's own launcher goes first.
    return tizenApps(function (err, list) {
      var t = !err && tizenAppFor(app, list);
      if (!t) {
        log('launch ' + app.name + ': no Tizen match (' + (err || 'not installed?') + '), trying the REST API');
        return tvApi('POST', app.id, function (err2, status) {
          if (err2 || status !== 200) return fail(res, 'launch ' + app.name, err2 || status);
          replyJson(res, { launched: true });
        });
      }
      try {
        tizen.application.launch(t.id, function () {
          log('launched ' + app.name + ' (' + t.id + ')');
          replyJson(res, { launched: true });
        }, function (e) { fail(res, 'launch ' + app.name + ' (' + t.id + ')', e.name + ' ' + e.message); });
      } catch (e) { fail(res, 'launch ' + app.name, e); }
    });
  }
  if (u.pathname === '/app-icon') {
    var iconApp = APP_CATALOGUE.filter(function (a) { return a.id === u.query.id; })[0];
    return tizenApps(function (err, list) {
      var t = !err && iconApp && tizenAppFor(iconApp, list);
      var send = function (err2, png) {
        if (err2) return fail(res, 'icon ' + iconApp.name, err2);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
        res.end(png);
      };
      var file = t && t.iconPath && !iconApp.noIcon && t.iconPath.replace(/^file:\/\//, '');
      if (file && fs.existsSync(file)) return fs.readFile(file, send);
      if (iconApp && iconApp.web) return webIcon(iconApp.web, send);
      reply(res, 404, 'text/plain', 'no icon');
    });
  }
  // POST /remote?key=KEY_HDMI1: a key on the TV's own remote channel. GET just connects (for agents).
  if (u.pathname === '/remote') {
    if (req.method === 'POST') {
      if (!/^KEY_[A-Z0-9_]{1,20}$/.test(u.query.key || '')) return reply(res, 400, 'text/plain', 'key=KEY_…');
      return remoteKey(u.query.key, function (err) {
        if (err) return fail(res, 'remote ' + u.query.key, err);
        log('remote: ' + u.query.key);
        replyJson(res, { sent: u.query.key });
      });
    }
    return remoteSession(function (err, msg, send, close) {
      if (err) return fail(res, 'remote', err);
      close();
      replyJson(res, { connected: true, event: msg.event, token: !!readData().remoteToken });
    });
  }
  // For agents: which of Tizen's APIs the service gets on this TV (and their methods).
  if (u.pathname === '/tizen-probe') {
    var out = { tizen: typeof tizen === 'undefined' ? 'undefined' : Object.keys(tizen), webapis: typeof webapis, apis: {} };
    if (typeof tizen !== 'undefined') {
      Object.keys(tizen).forEach(function (k) {
        var o = tizen[k];
        var names = [];
        try { for (var m in o) names.push(m); } catch (e) { names.push('error: ' + e); }
        out.apis[k] = names;
      });
    }
    if (typeof webapis !== 'undefined') {
      out.webapisApis = {};
      Object.keys(webapis).forEach(function (k) {
        var names = [];
        try { for (var m in webapis[k]) names.push(m); } catch (e) { names.push('error: ' + e); }
        out.webapisApis[k] = names.slice(0, 40);
      });
    }
    // ?notify=1: try a system notification, shown over any app.
    if (u.query.notify && typeof tizen !== 'undefined') {
      try {
        var Note = tizen.UserNotification || tizen.StatusNotification;
        var note = new Note('SIMPLE', 'anka tv', { content: 'Sistem bildirimi denemesi' });
        tizen.notification.post(note);
        out.notify = 'posted';
      } catch (e) { out.notify = 'failed: ' + e.name + ' ' + e.message; }
    }
    return replyJson(res, out);
  }
  if (u.pathname === '/tizen-apps') {
    return tizenApps(function (err, list) {
      if (err) return fail(res, 'tizen apps', err);
      replyJson(res, list);
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
        broadcast('settings', data.settings);
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
        broadcast('settings', data.settings);
        replyJson(res, data.settings);
      });
    }
    return replyJson(res, readData().settings || {});
  }
  if (u.pathname === '/state') {
    if (req.method === 'POST') {
      return readBody(req, function (b) {
        try {
          var before = pageState && JSON.stringify(Object.assign({}, pageState, { at: 0 }));
          pageState = JSON.parse(b);
          pageState.at = Date.now();
          // The page reports every 5 s; dashboards only hear about real changes.
          if (JSON.stringify(Object.assign({}, pageState, { at: 0 })) !== before) broadcast('state', { state: pageState, ageSeconds: 0 });
        } catch (e) {}
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
  clearInterval(pingTimer);
  listeners.forEach(function (l) { l.end(); });
  clearInterval(liveTimer);
  server.close(function () { done(); });
  sockets.slice().forEach(function (s) { s.destroy(); });
};

log('service ' + SERVICE_VERSION + ' started on port ' + PORT + ', node ' + process.version + ', tizen ' + typeof tizen);

// anka-tv service: runs inside TizenBrew's Node.js on the TV, without browser CORS limits.
// Plain ES5 on purpose: the TV's Node is v12, and TizenBrew mentions TVs with far older ones.
//
//   GET /streams?language=tr&limit=24   live streams, most watched first (language optional)
//   GET /channels?slugs=a,b             channel info and live status, in the given order
//   GET /master.m3u8?slug=X             the channel's master playlist, with CORS open
//   POST /log, GET /log                 page log lines (readable from the Mac: http://<tv ip>:8090/log)
//   POST /cmd, GET /cmd                 a command for the page, e.g. "play zeitnot" (the Mac can drive the app)
//   POST /notify, GET /notify           a toast for the page: JSON {"text": "...", "sound": true}
var http = require('http');
var https = require('https');
var url = require('url');

// Not 8085: the spike module's service may still hold it until TizenBrew restarts.
var PORT = 8090;
var UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 TV Safari/537.36';
var CACHE_MS = 20000;
var cache = {};
var logLines = [];
var commands = [];
var notifications = [];

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

http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (u.pathname === '/log') {
    if (req.method === 'POST') return readBody(req, function (b) { log(b); reply(res, 204, 'text/plain', ''); });
    return reply(res, 200, 'text/plain', logLines.join('\n') + '\n');
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
}).on('error', function (e) {
  // Without a handler a busy port would take down TizenBrew's whole service process with it.
  log('service: ' + e);
}).listen(PORT, '0.0.0.0');

log('service started on port ' + PORT + ', node ' + process.version);

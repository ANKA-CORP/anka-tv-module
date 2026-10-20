// anka-tv service: runs inside TizenBrew's Node.js on the TV, without browser CORS limits.
// Plain ES5 on purpose; TizenBrew's comments mention TVs with very old Node versions.
//
//   GET /top                  slug of the most-watched live channel
//   GET /master.m3u8?slug=X   the channel's master playlist, with CORS open
//   POST /log, GET /log       page log lines (readable from the Mac: http://<tv ip>:8085/log)
//   POST /cmd, GET /cmd       "<test> [channel slug]" for the page to run (the Mac can drive the tests)
var http = require('http');
var https = require('https');
var url = require('url');

var PORT = 8085;
var UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 TV Safari/537.36';
var logLines = [];
var pendingCmd = '';

function get(target, cb) {
  https.get(target, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(chunks).toString(), res.statusCode); });
  }).on('error', function (e) { cb(e); });
}

function log(line) {
  logLines.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (logLines.length > 300) logLines.shift();
}

function reply(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () { cb(body); });
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
  if (u.pathname === '/cmd') {
    if (req.method === 'POST') return readBody(req, function (b) { pendingCmd = b.trim(); log('cmd from Mac: ' + pendingCmd); reply(res, 204, 'text/plain', ''); });
    var cmd = pendingCmd;
    pendingCmd = '';
    return reply(res, 200, 'text/plain', cmd);
  }
  if (u.pathname === '/top') {
    return get('https://kick.com/stream/livestreams/en?page=1&limit=1&sort=desc', function (err, body, status) {
      if (err || status !== 200) return reply(res, 502, 'text/plain', 'top failed: ' + (err || status));
      try { reply(res, 200, 'text/plain', JSON.parse(body).data[0].channel.slug); } catch (e) { reply(res, 502, 'text/plain', 'top parse: ' + e); }
    });
  }
  if (u.pathname === '/master.m3u8') {
    return get('https://kick.com/api/v2/channels/' + encodeURIComponent(u.query.slug) + '/playback-url', function (err, body, status) {
      if (err || status !== 200) return reply(res, 502, 'text/plain', 'playback-url failed: ' + (err || status));
      var playback;
      try { playback = JSON.parse(body).data; } catch (e) { return reply(res, 502, 'text/plain', 'playback parse: ' + e); }
      get(playback, function (err2, m3u8, status2) {
        if (err2 || status2 !== 200) return reply(res, 502, 'text/plain', 'master failed: ' + (err2 || status2));
        reply(res, 200, 'application/vnd.apple.mpegurl', m3u8);
      });
    });
  }
  reply(res, 404, 'text/plain', 'not found');
}).listen(PORT, '0.0.0.0');

log('service started on port ' + PORT + ', node ' + process.version);

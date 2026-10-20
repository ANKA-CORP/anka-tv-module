// anka-tv service loader. TizenBrew runs this file once inside its own Node.js process and restarts it only if it
// crashed while loading, so a new service would otherwise wait for the TV to reboot. This file stays small and
// rarely changes: it fetches the real service (main.js) and swaps in the newest one on POST /reload-service.
// Plain ES5: the TV's Node is v12.4.
var fs = require('fs');
var https = require('https');

var MAIN_URL = 'https://cdn.jsdelivr.net/gh/ANKA-CORP/anka-tv-module@main/service/main.js';
var shared = { logLines: [] };
var current = null;

function note(line) {
  shared.logLines.push(new Date().toISOString().slice(11, 19) + ' loader: ' + line);
}

// On the Mac (tools/dev.sh) from the working copy, on the TV from the published module.
function fetchMain(cb) {
  if (process.env.ANKA_DEV_DIR) return fs.readFile(process.env.ANKA_DEV_DIR + '/service/main.js', 'utf8', cb);
  https.get(MAIN_URL + '?t=' + Date.now(), function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { body += c; });
    res.on('end', function () { cb(res.statusCode === 200 ? null : new Error('HTTP ' + res.statusCode), body); });
  }).on('error', cb);
}

function start() {
  fetchMain(function (err, code) {
    // Right after the TV boots the network may not be up yet.
    if (err) { note('fetching main.js failed: ' + err + '; retrying in 30 s'); return setTimeout(start, 30000); }
    var svc = {};
    try {
      new Function('require', 'tizen', 'exports', 'shared', 'reloadService', code)(
        require, typeof tizen === 'undefined' ? undefined : tizen, svc, shared, reload);
      current = svc;
    } catch (e) {
      note('main.js failed: ' + (e && e.stack || e) + '; retrying in 30 s');
      setTimeout(start, 30000);
    }
  });
}

function reload() {
  var old = current;
  current = null;
  if (old && old.stop) old.stop(start); else start();
}

// Nothing in TizenBrew's service process catches errors: one uncaught exception would take TizenBrew down with us.
process.on('uncaughtException', function (e) { note('uncaught: ' + (e && e.stack || e)); });

start();

// Shared helpers: the service, logging, formatting, keys and toasts.
// Classic script (no modules). TizenBrew's web view on our TV is Chromium 120 (logged on 2026-10-20).
'use strict';

// The module's service (service/service.js) runs on the TV itself; on the Mac, tools/dev.sh starts it.
var SERVICE = 'http://127.0.0.1:8090';

function log(msg) {
  try { console.log(msg); } catch (e) {}
  fetch(SERVICE + '/log', { method: 'POST', body: String(msg) }).catch(function () {});
}

window.addEventListener('error', function (e) { log('page error: ' + e.message + ' at ' + e.filename + ':' + e.lineno); });
window.addEventListener('unhandledrejection', function (e) { log('unhandled rejection: ' + e.reason); });

function api(path) {
  return fetch(SERVICE + path).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'HTTP ' + r.status); });
    return r.json();
  });
}

function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 12124 -> "12,1B", 812 -> "812"
function formatViewers(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'B';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'B';
  return String(n);
}

function formatUptime(startedAt) {
  var t = Date.parse(startedAt);
  if (!t) return '';
  var min = Math.max(0, Math.floor((Date.now() - t) / 60000));
  var h = Math.floor(min / 60);
  return h ? h + ' sa ' + (min % 60) + ' dk' : min + ' dk';
}

function metaLine(s) {
  var parts = [];
  if (s.live) parts.push(formatViewers(s.viewers) + ' izleyici');
  if (s.category) parts.push(s.category);
  if (s.live && s.startedAt) parts.push(formatUptime(s.startedAt) + ' önce başladı');
  return parts.join('  ·  ');
}

// Remote keys, with keyboard stand-ins for the Mac.
var KEY = {
  LEFT: [37], UP: [38], RIGHT: [39], DOWN: [40],
  ENTER: [13],
  BACK: [10009, 8, 27],                // Return, Backspace, Escape
  CH_UP: [427, 33], CH_DOWN: [428, 34], // ChannelUp/Down, PageUp/Down
  PLAY_PAUSE: [10252, 415, 19, 32]     // MediaPlayPause, MediaPlay, MediaPause, Space
};

function keyName(code) {
  for (var name in KEY) if (KEY[name].indexOf(code) >= 0) return name;
  return null;
}

var Toast = (function () {
  var box = null;
  var audio = null;

  // A soft two-note chime, generated so the module needs no sound files.
  function chime() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach(function (freq, i) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        var t = audio.currentTime + i * 0.16;
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g);
        g.connect(audio.destination);
        o.start(t);
        o.stop(t + 0.55);
      });
    } catch (e) { log('chime failed: ' + e); }
  }

  // show("text") or show({ text, title, level: 'info' | 'warn' | 'error', sound, seconds })
  function show(n) {
    if (typeof n === 'string') n = { text: n };
    box = box || document.getElementById('toasts');
    var t = el('div', 'toast' + (n.level && n.level !== 'info' ? ' ' + n.level : ''));
    if (n.title) t.appendChild(el('small', '', n.title));
    t.appendChild(document.createTextNode(n.text));
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    if (n.sound) chime();
    requestAnimationFrame(function () { requestAnimationFrame(function () { t.classList.add('in'); }); });
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, (n.seconds || 5) * 1000);
  }

  return { show: show };
})();

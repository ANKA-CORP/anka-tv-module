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

  function unlockSound() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { log('audio unavailable: ' + e); }
  }

  // A soft two-note chime, generated so the module needs no sound files.
  function chime() {
    try {
      unlockSound();
      if (audio.state !== 'running') log('chime skipped: audio ' + audio.state + ' (no key pressed yet)');
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

  // The boss alarm: a war horn over three drum hits, twice, loud enough to cross the room.
  function alarm() {
    try {
      unlockSound();
      if (audio.state !== 'running') log('alarm skipped: audio ' + audio.state + ' (no key pressed yet)');
      var out = audio.createGain();
      out.gain.value = 0.55;
      out.connect(audio.destination);
      var now = audio.currentTime;
      var drum = function (t) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
        g.gain.setValueAtTime(1, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(g);
        g.connect(out);
        o.start(t);
        o.stop(t + 0.4);
      };
      var horn = function (t, len) {
        var f = audio.createBiquadFilter();
        var g = audio.createGain();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(400, t);
        f.frequency.linearRampToValueAtTime(2200, t + 0.25);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.32, t + 0.12);
        g.gain.setValueAtTime(0.32, t + len - 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        f.connect(g);
        g.connect(out);
        [110, 165, 220.5].forEach(function (freq) {
          var o = audio.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(freq * 0.94, t);
          o.frequency.linearRampToValueAtTime(freq, t + 0.15);
          o.connect(f);
          o.start(t);
          o.stop(t + len);
        });
      };
      [0, 2.4].forEach(function (at) {
        horn(now + at, 1.3);
        drum(now + at + 1.4);
        drum(now + at + 1.7);
        drum(now + at + 2.0);
      });
    } catch (e) { log('alarm failed: ' + e); }
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  // A boss is close: a card drops in at the top with the bosses' portraits, the spawn time and a live countdown.
  function boss(n) {
    if (n.at <= Date.now()) return;
    var card = document.getElementById('boss');
    var list = document.getElementById('boss-list');
    var spawn = new Date(n.at);
    list.innerHTML = '';
    n.bosses.forEach(function (b, i) {
      var item = el('div', 'boss-item');
      item.style.setProperty('--i', i);
      var img = el('img');
      img.src = b.image;
      img.onerror = function () { img.style.visibility = 'hidden'; };
      item.appendChild(img);
      item.appendChild(el('span', '', b.name));
      list.appendChild(item);
    });
    document.getElementById('boss-time').textContent = two(spawn.getHours()) + ':' + two(spawn.getMinutes());
    document.getElementById('boss-test').style.display = n.test ? '' : 'none';
    card.classList.toggle('many', n.bosses.length > 2);
    var left = document.getElementById('boss-left');
    var tick = function () {
      var s = Math.max(0, Math.round((n.at - Date.now()) / 1000));
      var h = Math.floor(s / 3600);
      left.textContent = (h ? h + ':' + two(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ':' + two(s % 60);
    };
    tick();
    clearInterval(boss.timer);
    clearTimeout(boss.hide);
    boss.timer = setInterval(tick, 1000);
    card.classList.remove('on');
    void card.offsetWidth;   // restart the entrance animation
    card.classList.add('on');
    if (n.sound !== false) alarm();
    boss.hide = setTimeout(closeBoss, (n.seconds || 30) * 1000);
  }

  function bossOpen() { return document.getElementById('boss').classList.contains('on'); }

  function closeBoss() {
    document.getElementById('boss').classList.remove('on');
    clearInterval(boss.timer);
    clearTimeout(boss.hide);
  }

  // show("text") or show({ text, title, level: 'info' | 'warn' | 'error', sound, seconds }); kind 'boss' gets the boss card.
  function show(n) {
    if (typeof n === 'string') n = { text: n };
    if (n.kind === 'boss') return boss(n);
    box = box || document.getElementById('toasts');
    var t = el('div', 'toast' + (n.level && n.level !== 'info' ? ' ' + n.level : '') + (n.kind === 'live' ? ' live' : ''));
    // A channel's picture in place of the mark (a favourite going live).
    if (n.avatar) {
      var face = el('img', 'toast-avatar');
      face.src = n.avatar;
      t.classList.add('has-avatar');
      t.appendChild(face);
    }
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

  return { show: show, unlockSound: unlockSound, bossOpen: bossOpen, closeBoss: closeBoss };
})();

// The grid: a hero for the focused stream, rows of cards, remote navigation, favourites and refresh.
'use strict';

var DEFAULT_FAVOURITES = ['zeitnot', 'nuriben'];
var REFRESH_MS = 60000;
var VISIBLE_CARDS = 4;     // cards fully on screen; a fifth peeks in
var CARD_STEP = 416;       // card width + margin
var ROW_HEIGHT = 360;
var LONG_PRESS_MS = 650;

var rows = [];             // [{ id, title, items: [stream], col, first, el, track }]
var focusRow = 0;
var heroSlug = null, heroTimer = null, heroLayer = 0;

function $(id) { return document.getElementById(id); }

// Favourites live on the TV (localStorage); long-press OK on a card toggles one.
var Favourites = {
  list: function () {
    try {
      var saved = JSON.parse(localStorage.getItem('favourites'));
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return DEFAULT_FAVOURITES.slice();
  },
  has: function (slug) { return this.list().indexOf(slug) >= 0; },
  toggle: function (slug) {
    var l = this.list();
    var i = l.indexOf(slug);
    if (i >= 0) l.splice(i, 1); else l.push(slug);
    try { localStorage.setItem('favourites', JSON.stringify(l)); } catch (e) { log('favourites not saved: ' + e); }
    return i < 0;
  }
};

function fitStage() {
  var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('stage').style.transform = 'scale(' + s + ')';
}

function tickClock() {
  var d = new Date();
  $('clock').textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// ---- data

function loadRows() {
  var favs = Favourites.list();
  return Promise.all([
    favs.length ? api('/channels?slugs=' + favs.map(encodeURIComponent).join(',')) : Promise.resolve([]),
    api('/streams?language=tr&limit=30'),
    api('/streams?limit=30')
  ]).then(function (r) {
    var favItems = r[0].slice().sort(function (a, b) { return (b.live - a.live) || (b.viewers - a.viewers); });
    return [
      { id: 'fav', title: 'Favoriler', note: favItems.filter(function (s) { return s.live; }).length + ' canlı', items: favItems },
      { id: 'tr', title: 'Türkçe canlı yayınlar', items: r[1] },
      { id: 'all', title: "Kick'te en çok izlenenler", items: r[2] }
    ];
  });
}

function refresh() {
  if (Player.isOpen()) return Promise.resolve();
  return loadRows().then(function (fresh) {
    // Keep the focus on the same stream (or the same position) across refreshes.
    var keep = rows.map(function (r) { var s = r.items[r.col]; return s ? s.slug : null; });
    fresh.forEach(function (r, i) {
      var old = rows[i];
      r.col = 0;
      r.first = 0;
      if (old) {
        var at = keep[i] ? r.items.map(function (s) { return s.slug; }).indexOf(keep[i]) : -1;
        r.col = at >= 0 ? at : Math.min(old.col, Math.max(0, r.items.length - 1));
        r.first = Math.max(0, Math.min(old.first, r.col));
        if (r.col >= r.first + VISIBLE_CARDS) r.first = r.col - VISIBLE_CARDS + 1;
      }
    });
    rows = fresh;
    render();
  }).catch(function (e) {
    log('refresh failed: ' + e);
    if (!rows.length) {
      $('empty').style.display = 'block';
      $('empty').textContent = 'Kick şu an yanıt vermiyor. Biraz sonra yeniden denenecek.';
    } else {
      Toast.show({ text: 'Liste yenilenemedi, birazdan tekrar denenecek.', level: 'warn' });
    }
  });
}

// ---- rendering

function card(s, row) {
  var c;
  if (s.live) {
    c = el('div', 'card');
    var img = el('img', 'thumb');
    img.dataset.src = s.thumb;
    c.appendChild(img);
    c.appendChild(el('span', 'pill live', 'CANLI'));
    c.appendChild(el('span', 'viewers', formatViewers(s.viewers)));
    c.appendChild(el('div', 'shade'));
  } else {
    c = el('div', 'card offline');
    if (s.avatar) { var av = el('img', 'avatar'); av.dataset.src = s.avatar; c.appendChild(av); }
  }
  var label = el('div', 'label', s.name);
  label.appendChild(el('small', '', s.live ? s.title : 'Çevrimdışı'));
  c.appendChild(label);
  if (row.id !== 'fav' && Favourites.has(s.slug)) c.appendChild(el('span', 'fav', '★'));
  return c;
}

function hintCard() {
  var c = el('div', 'card hint');
  c.appendChild(el('div', 'label', 'Bir kanalın üstünde OK tuşuna basılı tutarak favorilere ekle'));
  return c;
}

function render() {
  var inner = $('rows-inner');
  inner.innerHTML = '';
  $('empty').style.display = 'none';
  rows.forEach(function (r) {
    r.el = el('div', 'row');
    var title = el('div', 'row-title', r.title);
    if (r.note) title.appendChild(el('small', '', r.note));
    r.el.appendChild(title);
    r.track = el('div', 'track');
    if (!r.items.length) r.track.appendChild(r.id === 'fav' ? hintCard() : el('div', 'card skeleton'));
    r.items.forEach(function (s) { r.track.appendChild(card(s, r)); });
    r.el.appendChild(r.track);
    inner.appendChild(r.el);
  });
  if (focusRow >= rows.length) focusRow = 0;
  updateFocus(true);
}

function renderSkeleton() {
  var inner = $('rows-inner');
  ['Favoriler', 'Türkçe canlı yayınlar'].forEach(function (t) {
    var row = el('div', 'row');
    row.appendChild(el('div', 'row-title', t));
    var track = el('div', 'track');
    for (var i = 0; i < 5; i++) track.appendChild(el('div', 'card skeleton'));
    row.appendChild(track);
    inner.appendChild(row);
  });
}

// Load images only near the visible window, so the TV doesn't fetch 90 thumbnails at once.
function loadImages(r) {
  var cards = r.track.children;
  for (var i = Math.max(0, r.first - 2); i < Math.min(cards.length, r.first + VISIBLE_CARDS + 4); i++) {
    var imgs = cards[i].getElementsByTagName('img');
    for (var j = 0; j < imgs.length; j++) {
      if (imgs[j].dataset.src && !imgs[j].src) { imgs[j].decoding = 'async'; imgs[j].src = imgs[j].dataset.src; }
    }
  }
}

function updateFocus(instant) {
  var prev = document.querySelector('.card.focused');
  if (prev) prev.classList.remove('focused');
  $('rows-inner').style.transform = 'translateY(' + (-focusRow * ROW_HEIGHT) + 'px)';
  rows.forEach(function (r, i) {
    r.el.classList.toggle('above', i < focusRow);
    r.track.style.transform = 'translateX(' + (-r.first * CARD_STEP) + 'px)';
    if (i >= focusRow - 1 && i <= focusRow + 1) loadImages(r);
  });
  var r = rows[focusRow];
  if (!r) return;
  var c = r.track.children[r.col];
  if (c) c.classList.add('focused');
  var s = r.items[r.col];
  if (!s) return;
  renderHeroText(s);
  clearTimeout(heroTimer);
  // The text follows the focus at once; the big picture waits for the remote to settle.
  heroTimer = setTimeout(function () { renderHeroImage(s); }, instant ? 0 : 250);
}

function renderHeroText(s) {
  var tags = $('hero-tags');
  tags.innerHTML = '';
  tags.appendChild(el('span', s.live ? 'pill live' : 'pill off', s.live ? 'CANLI' : 'ÇEVRİMDIŞI'));
  if (s.category) tags.appendChild(document.createTextNode(s.category));
  var name = $('hero-name');
  name.innerHTML = '';
  if (s.avatar) { var img = el('img'); img.src = s.avatar; name.appendChild(img); }
  name.appendChild(document.createTextNode(s.name));
  $('hero-title').textContent = s.live ? s.title : 'Şu an yayında değil.';
  $('hero-meta').textContent = metaLine(s) + (Favourites.has(s.slug) ? '  ·  ★ Favori' : '');
}

function renderHeroImage(s) {
  var bg = s.live ? s.hero : s.offlineImage || '';
  if (s.slug === heroSlug && bg) return;
  heroSlug = s.slug;
  // Cross-fade two layers once the new picture has loaded.
  var next = $(heroLayer ? 'hero-bg-a' : 'hero-bg-b');
  var cur = $(heroLayer ? 'hero-bg-b' : 'hero-bg-a');
  if (!bg) { cur.classList.remove('on'); return; }
  var pre = new Image();
  pre.onload = function () {
    if (heroSlug !== s.slug) return;
    next.style.backgroundImage = 'url("' + bg + '")';
    next.classList.add('on');
    cur.classList.remove('on');
    heroLayer = 1 - heroLayer;
  };
  pre.src = bg;
}

// ---- navigation

function move(dRow, dCol) {
  if (!rows.length) return;
  if (dRow) {
    var to = focusRow + dRow;
    if (to < 0 || to >= rows.length) return;
    focusRow = to;
  } else {
    var r = rows[focusRow];
    var col = r.col + dCol;
    if (col < 0 || col >= r.items.length) return;
    r.col = col;
    if (col < r.first) r.first = col;
    if (col >= r.first + VISIBLE_CARDS) r.first = col - VISIBLE_CARDS + 1;
  }
  updateFocus(false);
}

function activate() {
  var r = rows[focusRow];
  var s = r && r.items[r.col];
  if (!s) return;
  if (!s.live) { Toast.show({ text: s.name + ' şu an yayında değil.' }); return; }
  var live = r.items.filter(function (x) { return x.live; });
  log('open ' + s.slug + ' from ' + r.id);
  Player.open(live, live.indexOf(s), function (last) {
    // Back in the grid: focus the channel we ended up on, if it's in this row.
    var at = r.items.indexOf(last);
    if (at >= 0) { r.col = at; if (at < r.first) r.first = at; if (at >= r.first + VISIBLE_CARDS) r.first = at - VISIBLE_CARDS + 1; }
    updateFocus(true);
    refresh();
  });
}

function toggleFavourite() {
  var r = rows[focusRow];
  var s = r && r.items[r.col];
  if (!s) return;
  var added = Favourites.toggle(s.slug);
  Toast.show({ text: s.name + (added ? ' favorilere eklendi ★' : ' favorilerden çıkarıldı') });
  log('favourite ' + (added ? 'added ' : 'removed ') + s.slug);
  refresh();
}

function exitApp() {
  // TizenBrew opened us by navigating here, so going back returns to its menu.
  history.back();
}

// OK is a tap when released quickly and a long press (favourite) when held.
var enterTimer = null, enterLong = false;

function handleKeyDown(name, repeat) {
  if (Player.isOpen()) { if (!repeat || name !== 'ENTER') Player.handleKey(name); return; }
  if (name === 'ENTER') {
    if (repeat || enterTimer) return;
    enterLong = false;
    enterTimer = setTimeout(function () { enterLong = true; enterTimer = null; toggleFavourite(); }, LONG_PRESS_MS);
    return;
  }
  if (name === 'LEFT') move(0, -1);
  else if (name === 'RIGHT') move(0, 1);
  else if (name === 'UP') move(-1, 0);
  else if (name === 'DOWN') move(1, 0);
  else if (name === 'BACK') exitApp();
}

function handleKeyUp(name) {
  if (name !== 'ENTER' || Player.isOpen()) return;
  if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; if (!enterLong) activate(); }
}

// Time from a key press to the frame that shows it, logged every 20 presses so the Mac can see lag.
var latencies = [];

function measure(t0) {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      latencies.push(performance.now() - t0);
      if (latencies.length < 20) return;
      var sum = latencies.reduce(function (a, b) { return a + b; }, 0);
      log('key-to-frame avg ' + Math.round(sum / latencies.length) + ' ms, max ' + Math.round(Math.max.apply(null, latencies)) + ' ms');
      latencies = [];
    });
  });
}

document.addEventListener('keydown', function (e) {
  var name = keyName(e.keyCode);
  if (!name) return;
  e.preventDefault();
  // Browsers only allow sound after a key press, so the toast chime is unlocked here.
  Toast.unlockSound();
  measure(performance.now());
  handleKeyDown(name, e.repeat);
});
document.addEventListener('keyup', function (e) {
  var name = keyName(e.keyCode);
  if (!name) return;
  e.preventDefault();
  handleKeyUp(name);
});

// ---- commands and notifications from the Mac (through the service)

function pressKey(name) {
  handleKeyDown(name, false);
  if (name === 'ENTER') { clearTimeout(enterTimer); enterTimer = null; activate(); }
}

function runCommand(cmd) {
  var parts = cmd.split(' ');
  log('command: ' + cmd);
  if (parts[0] === 'key' && KEY[parts[1]]) pressKey(parts[1]);
  else if (parts[0] === 'play' && parts[1]) {
    api('/channels?slugs=' + encodeURIComponent(parts[1])).then(function (l) {
      if (!l[0] || !l[0].live) { Toast.show({ text: parts[1] + ' şu an yayında değil.' }); return; }
      if (Player.isOpen()) Player.close();
      Player.open(l, 0, function () { updateFocus(true); refresh(); });
    });
  } else if (parts[0] === 'reload') location.reload();
  else if (parts[0] === 'refresh') refresh();
  else log('unknown command: ' + cmd);
}

function poll() {
  api('/cmd').then(function (l) { l.forEach(runCommand); }).catch(function () {});
  api('/notify').then(function (l) { l.forEach(function (n) { Toast.show(n); }); }).catch(function () {});
}

// ---- updates: reload when a newer version is published and nobody is watching

var VERSION_URL = 'https://cdn.jsdelivr.net/gh/ANKA-CORP/anka-tv-module@main/version.json';
var loadedVersion = null;

function checkVersion() {
  fetch(VERSION_URL + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (!v) return;
    if (!loadedVersion) {
      loadedVersion = v.commit;
      $('version').textContent = 'v' + v.version;
      log('version ' + v.version + ' (' + v.commit + ')');
      return;
    }
    if (v.commit !== loadedVersion && !Player.isOpen()) {
      log('new version ' + v.commit + ', reloading');
      location.reload();
    }
  }).catch(function () {});
}

// ---- start

function main() {
  fitStage();
  window.addEventListener('resize', fitStage);
  tickClock();
  setInterval(tickClock, 10000);
  Player.init();
  renderSkeleton();
  log('app started: ' + navigator.userAgent);
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(poll, 1500);
  // Only on the TV, where TizenBrew serves the published version (on port 8081).
  if (location.port === '8081') {
    checkVersion();
    setInterval(checkVersion, 3 * 60000);
  } else {
    $('version').textContent = 'dev';
  }
}

main();

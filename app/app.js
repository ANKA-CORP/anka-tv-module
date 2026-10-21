// The home screen: a hero for the focused item, rows of apps and Kick streams, remote navigation,
// favourites, weather and refresh.
'use strict';

var DEFAULT_FAVOURITES = ['zeitnot', 'nuriben'];
var REFRESH_MS = 60000;
var startedAt = Date.now();
var LONG_PRESS_MS = 650;
// Per row kind: cards fully on screen (one more peeks in), card width + margin, row height.
var LAYOUT = {
  apps: { visible: 5, step: 320, height: 290 },
  streams: { visible: 4, step: 416, height: 360 }
};

var rows = [];             // [{ id, kind, title, items, col, first, el, track }]
var focusRow = 0;
var heroSlug = null, heroTimer = null, heroLayer = 0;

function $(id) { return document.getElementById(id); }

// Favourites are saved by the service on the TV, so the dashboard edits the same list.
// Long-press OK on a card toggles one.
var Favourites = {
  slugs: DEFAULT_FAVOURITES.slice(),
  load: function () {
    var self = this;
    return api('/favourites').then(function (r) {
      if (r.favourites) { self.slugs = r.favourites; return; }
      // First run with the service: keep what earlier versions kept in localStorage.
      try {
        var old = JSON.parse(localStorage.getItem('favourites'));
        if (Array.isArray(old)) self.slugs = old;
      } catch (e) {}
      return self.save();
    }).catch(function (e) { log('favourites not loaded: ' + e); });
  },
  save: function () {
    return fetch(SERVICE + '/favourites', { method: 'POST', body: JSON.stringify(this.slugs) })
      .catch(function (e) { log('favourites not saved: ' + e); });
  },
  list: function () { return this.slugs.slice(); },
  has: function (slug) { return this.slugs.indexOf(slug) >= 0; },
  toggle: function (slug) {
    var i = this.slugs.indexOf(slug);
    if (i >= 0) this.slugs.splice(i, 1); else this.slugs.push(slug);
    this.save();
    return i < 0;
  }
};

// Tells the service (and so the dashboard) what's on screen.
function reportState() {
  var s = Player.isOpen() ? Player.current() : null;
  var state = { screen: s ? 'player' : 'grid', version: $('version').textContent };
  if (s) {
    state.slug = s.slug; state.name = s.name; state.title = s.title; state.avatar = s.avatar;
    state.thumb = s.thumb; state.viewers = s.viewers; state.category = s.category; state.quality = Player.quality();
  }
  fetch(SERVICE + '/state', { method: 'POST', body: JSON.stringify(state) }).catch(function () {});
}

function fitStage() {
  var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('stage').style.transform = 'scale(' + s + ')';
}

function tickClock() {
  var d = new Date();
  $('clock').textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  $('date').textContent = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
}

// WMO weather codes (Open-Meteo) in a few Turkish words.
function weatherText(code) {
  if (code === 0) return 'Açık';
  if (code <= 2) return 'Parçalı bulutlu';
  if (code === 3) return 'Bulutlu';
  if (code <= 48) return 'Sisli';
  if (code <= 57) return 'Çisenti';
  if (code <= 67) return 'Yağmurlu';
  if (code <= 77) return 'Karlı';
  if (code <= 82) return 'Sağanak';
  if (code <= 86) return 'Kar sağanağı';
  return 'Fırtına';
}

function loadWeather() {
  api('/weather').then(function (w) {
    var box = $('weather');
    box.innerHTML = '';
    if (!w) return;   // no city set yet: the dashboard sets one
    box.appendChild(el('b', '', w.temp + '°'));
    box.appendChild(document.createTextNode(weatherText(w.code) + ' · ' + w.city));
  }).catch(function (e) { log('weather not loaded: ' + e); });
}

// ---- data

function loadRows() {
  // Reload favourites and settings each time: the dashboard may have changed them.
  return Promise.all([Favourites.load(), loadSettings()]).then(loadRowsFor);
}

var THEMES = ['night', 'ocean', 'sunset', 'lavender', 'oled', 'glass', 'neon', 'aurora', 'brutal'];
var DEFAULT_THEME = 'sunset';

function loadSettings() {
  return api('/settings').then(function (s) {
    var theme = THEMES.indexOf(s.theme) >= 0 ? s.theme : DEFAULT_THEME;
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
      log('theme ' + theme);
    }
    // "Sade" in the dashboard stops all motion if the TV ever struggles.
    document.documentElement.dataset.motion = s.motion === 'reduced' ? 'reduced' : 'full';
  }).catch(function (e) { log('settings not loaded: ' + e); });
}

function loadRowsFor() {
  var favs = Favourites.list();
  return Promise.all([
    api('/apps').catch(function (e) { log('apps not loaded: ' + e); return []; }),
    favs.length ? api('/channels?slugs=' + favs.map(encodeURIComponent).join(',')) : Promise.resolve([]),
    api('/streams?language=tr&limit=30'),
    api('/streams?limit=30'),
    // Channels watched lately, without the favourites (they have their own row).
    api('/recent').then(function (slugs) {
      slugs = slugs.filter(function (s) { return favs.indexOf(s) < 0; }).slice(0, 10);
      return slugs.length ? api('/channels?slugs=' + slugs.map(encodeURIComponent).join(',')) : [];
    }).catch(function () { return []; })
  ]).then(function (r) {
    var apps = r[0].map(function (a) { return { kind: 'app', key: a.id, id: a.id, name: a.name, color: a.color, plate: a.plate, icon: a.icon }; });
    var stream = function (s) { s.kind = 'stream'; s.key = s.slug; return s; };
    var favItems = r[1].map(stream).sort(function (a, b) { return (b.live - a.live) || (b.viewers - a.viewers); });
    var list = [];
    if (apps.length) list.push({ id: 'apps', kind: 'apps', title: 'Uygulamalar', items: apps });
    list.push({ id: 'fav', kind: 'streams', title: 'Kick · Favoriler', note: favItems.filter(function (s) { return s.live; }).length + ' canlı', items: favItems });
    if (r[4].length) list.push({ id: 'recent', kind: 'streams', title: 'Son izlenenler', items: r[4].map(stream) });
    list.push({ id: 'tr', kind: 'streams', title: 'Kick · Türkçe canlı yayınlar', items: r[2].map(stream) });
    list.push({ id: 'all', kind: 'streams', title: "Kick · En çok izlenenler", items: r[3].map(stream) });
    return list;
  });
}

function layout(r) { return LAYOUT[r.kind]; }

// Keep the focused card inside the visible window of its row.
function scrollTo(r, col) {
  var visible = layout(r).visible;
  r.col = col;
  if (col < r.first) r.first = col;
  if (col >= r.first + visible) r.first = col - visible + 1;
}

function refresh() {
  if (Player.isOpen()) return Promise.resolve();
  return loadRows().then(function (fresh) {
    // Keep the focus on the same stream (or the same position) across refreshes.
    var focusedRowId = rows[focusRow] ? rows[focusRow].id : null;
    fresh.forEach(function (r) {
      var old = rows.filter(function (o) { return o.id === r.id; })[0];
      r.col = 0;
      r.first = 0;
      if (old) {
        var keep = old.items[old.col] ? old.items[old.col].key : null;
        var at = keep ? r.items.map(function (s) { return s.key; }).indexOf(keep) : -1;
        r.first = old.first;
        scrollTo(r, at >= 0 ? at : Math.min(old.col, Math.max(0, r.items.length - 1)));
      }
    });
    var stay = fresh.map(function (r) { return r.id; }).indexOf(focusedRowId);
    if (stay >= 0) focusRow = stay;
    rows = fresh;
    render();
    loadWidgets();
    Splash.end();
  }).catch(function (e) {
    log('refresh failed: ' + e);
    if (!rows.length) {
      // Right after the TV starts, the service is still being fetched (service/service.js): try again soon.
      var starting = Date.now() - startedAt < 60000;
      $('empty').style.display = 'block';
      $('empty').textContent = starting ? 'Bağlanıyor…' : 'Kick şu an yanıt vermiyor. Biraz sonra yeniden denenecek.';
      if (starting) setTimeout(refresh, 3000);
    } else {
      Toast.show({ text: 'Liste yenilenemedi, birazdan tekrar denenecek.', level: 'warn' });
    }
  });
}

// ---- widgets under the hero: the next boss and the favourites that are live, refreshed with the rows

var nextBoss = null;

function loadWidgets() {
  api('/bosses').then(function (l) { nextBoss = l[0] || null; }).catch(function () { nextBoss = null; }).then(renderWidgets);
}

function renderWidgets() {
  var box = $('widgets');
  box.innerHTML = '';
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var faces = function (urls) {
    var f = el('div', 'faces');
    urls.slice(0, 3).forEach(function (u) { if (u) { var img = el('img'); img.src = u; f.appendChild(img); } });
    return f;
  };
  var text = function (label, value) {
    var t = el('div', 'w-text');
    t.appendChild(el('small', '', label));
    t.appendChild(el('b', '', value));
    return t;
  };
  if (nextBoss && nextBoss.at > Date.now()) {
    var w = el('div', 'widget boss');
    var d = new Date(nextBoss.at);
    var mins = Math.max(0, Math.round((nextBoss.at - Date.now()) / 60000));
    w.appendChild(faces(nextBoss.bosses.map(function (b) { return b.image; })));
    w.appendChild(text('Sıradaki boss · ' + two(d.getHours()) + ':' + two(d.getMinutes()), nextBoss.bosses.map(function (b) { return b.name; }).join(', ')));
    // The ring fills over the last hour before the spawn.
    var ring = el('div', 'ring');
    ring.style.setProperty('--p', String(Math.max(0, Math.min(1, 1 - mins / 60))));
    var label = el('span', '', mins < 60 ? String(mins) : Math.floor(mins / 60) + 's');
    label.appendChild(el('i', '', mins < 60 ? 'dk' : (mins % 60) + 'dk'));
    ring.appendChild(label);
    w.appendChild(ring);
    box.appendChild(w);
  }
  var fav = rows.filter(function (r) { return r.id === 'fav'; })[0];
  var live = fav ? fav.items.filter(function (s) { return s.live; }) : [];
  if (live.length) {
    var lw = el('div', 'widget live');
    lw.appendChild(faces(live.map(function (s) { return s.avatar; })));
    lw.appendChild(text('Favorilerden canlı', live.length === 1 ? live[0].name : live.slice(0, 2).map(function (s) { return s.name; }).join(', ') + (live.length > 2 ? ' +' + (live.length - 2) : '')));
    lw.appendChild(el('span', 'live-dot'));
    box.appendChild(lw);
  }
}

// ---- rendering

function appCard(a) {
  var c = el('div', 'card app');
  c.style.background = 'linear-gradient(135deg, ' + a.color + ' 0%, ' + shade(a.color) + ' 100%)';
  // The app's own icon, read from the TV by the service (none of it is in this repo).
  if (a.icon) {
    var img = el('img', 'app-icon' + (a.plate ? ' plated' : ''));
    if (a.plate) img.style.backgroundColor = a.plate;
    img.onerror = function () { c.classList.remove('has-icon'); c.removeChild(img); };
    img.src = SERVICE + a.icon;
    c.classList.add('has-icon');
    c.appendChild(img);
  }
  c.appendChild(el('div', 'app-name', a.name));
  return c;
}

// A darker version of a #rrggbb colour, for the tile gradient.
function shade(hex) {
  var n = parseInt(hex.slice(1), 16);
  var f = function (v) { return Math.round(v * 0.55); };
  return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
}

function card(s, row) {
  if (s.kind === 'app') return appCard(s);
  var c;
  if (s.live) {
    c = el('div', 'card');
    var img = el('img', 'thumb');
    img.dataset.src = s.thumb;
    c.appendChild(img);
    c.appendChild(el('span', 'pill live', 'Canlı'));
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
    r.el = el('div', 'row row-' + r.kind);
    var title = el('div', 'row-title', r.title);
    if (r.note) title.appendChild(el('small', '', r.note));
    r.el.appendChild(title);
    r.track = el('div', 'track');
    if (!r.items.length) r.track.appendChild(r.id === 'fav' ? hintCard() : el('div', 'card skeleton'));
    r.items.forEach(function (s, i) {
      var c = card(s, r);
      // Only on the first fill: the visible cards rise into place one after another.
      if (!rendered && i < 7) { c.classList.add('arrive'); c.style.setProperty('--i', i + rows.indexOf(r) * 3); }
      r.track.appendChild(c);
    });
    r.el.appendChild(r.track);
    inner.appendChild(r.el);
  });
  rendered = true;
  if (focusRow >= rows.length) focusRow = 0;
  updateFocus(true);
}

var rendered = false;

// A dozen embers drifting up through the hero, each with its own pace, delay and sway.
function makeEmbers() {
  var layer = $('embers-layer');
  for (var i = 0; i < 14; i++) {
    var e = el('span', 'ember');
    var size = 3 + Math.random() * 5;
    e.style.left = (900 + Math.random() * 980) + 'px';
    e.style.width = e.style.height = size + 'px';
    e.style.setProperty('--d', (9 + Math.random() * 9).toFixed(1) + 's');
    e.style.setProperty('--delay', (-Math.random() * 15).toFixed(1) + 's');
    e.style.setProperty('--sway', ((Math.random() - 0.5) * 160).toFixed(0) + 'px');
    layer.appendChild(e);
  }
}

function renderSkeleton() {
  var inner = $('rows-inner');
  ['Uygulamalar', 'Kick · Favoriler'].forEach(function (t) {
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
  for (var i = Math.max(0, r.first - 2); i < Math.min(cards.length, r.first + layout(r).visible + 4); i++) {
    var imgs = cards[i].getElementsByTagName('img');
    for (var j = 0; j < imgs.length; j++) {
      if (imgs[j].dataset.src && !imgs[j].src) { imgs[j].decoding = 'async'; imgs[j].src = imgs[j].dataset.src; }
    }
  }
}

function updateFocus(instant) {
  var prev = document.querySelector('.card.focused');
  if (prev) prev.classList.remove('focused');
  var offset = 0;
  for (var k = 0; k < focusRow; k++) offset += layout(rows[k]).height;
  $('rows-inner').style.transform = 'translateY(' + (-offset) + 'px)';
  rows.forEach(function (r, i) {
    r.el.classList.toggle('above', i < focusRow);
    r.track.style.transform = 'translateX(' + (-r.first * layout(r).step) + 'px)';
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

var heroTextKey = null;

function renderHeroText(s) {
  // Replay the arrival only when the focused item really changes, not on a background refresh.
  if (s.key !== heroTextKey) {
    heroTextKey = s.key;
    var info = $('hero-info');
    info.classList.remove('enter');
    void info.offsetWidth;
    info.classList.add('enter');
  }
  if (s.kind === 'app') return renderAppHero(s);
  var tags = $('hero-tags');
  tags.innerHTML = '';
  tags.appendChild(el('span', s.live ? 'pill live' : 'pill off', s.live ? 'Canlı' : 'Çevrimdışı'));
  if (s.category) tags.appendChild(document.createTextNode(s.category));
  var name = $('hero-name');
  name.innerHTML = '';
  if (s.avatar) { var img = el('img'); img.src = s.avatar; name.appendChild(img); }
  name.appendChild(document.createTextNode(s.name));
  $('hero-title').textContent = s.live ? s.title : 'Şu an yayında değil.';
  $('hero-meta').textContent = metaLine(s) + (Favourites.has(s.slug) ? '  ·  ★ Favori' : '');
}

function renderAppHero(a) {
  var tags = $('hero-tags');
  tags.innerHTML = '';
  var input = a.id === 'ps5';
  tags.appendChild(el('span', 'pill app', input ? 'HDMI girişi' : 'Uygulama'));
  var name = $('hero-name');
  name.innerHTML = '';
  if (a.icon) {
    var img = el('img', 'app' + (a.plate ? ' plated' : ''));
    img.src = SERVICE + a.icon;
    if (a.plate) img.style.backgroundColor = a.plate;
    img.style.boxShadow = '0 0 0 3px ' + a.color + ', 0 0 44px ' + a.color;
    name.appendChild(img);
  }
  name.appendChild(document.createTextNode(a.name));
  $('hero-title').textContent = input ? 'Geçmek için OK' : 'Açmak için OK';
  $('hero-meta').textContent = 'Geri dönmek için: Home → anka tv';
}

function renderHeroImage(s) {
  var bg = s.kind === 'app' ? '' : s.live ? s.hero : s.offlineImage || '';
  if (s.key === heroSlug && bg) return;
  heroSlug = s.key;
  if (s.kind === 'app') {
    // Apps have no picture: a wash of the app's colour instead.
    var layer = $(heroLayer ? 'hero-bg-a' : 'hero-bg-b');
    var old = $(heroLayer ? 'hero-bg-b' : 'hero-bg-a');
    layer.classList.add('app');
    layer.style.backgroundImage = 'radial-gradient(ellipse at 70% 40%, ' + s.color + ' 0%, ' + shade(s.color) + ' 45%, rgba(0,0,0,0) 75%)';
    layer.classList.add('on');
    old.classList.remove('on');
    heroLayer = 1 - heroLayer;
    return;
  }
  // Cross-fade two layers once the new picture has loaded.
  var next = $(heroLayer ? 'hero-bg-a' : 'hero-bg-b');
  var cur = $(heroLayer ? 'hero-bg-b' : 'hero-bg-a');
  if (!bg) { cur.classList.remove('on'); return; }
  var pre = new Image();
  pre.onload = function () {
    if (heroSlug !== s.key) return;
    next.style.backgroundImage = 'url("' + bg + '")';
    next.classList.remove('app');
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
    scrollTo(r, col);
  }
  updateFocus(false);
}

function activate() {
  var r = rows[focusRow];
  var s = r && r.items[r.col];
  if (!s) return;
  if (s.kind === 'app') return launchApp(s);
  if (!s.live) { Toast.show({ text: s.name + ' şu an yayında değil.' }); return; }
  var live = r.items.filter(function (x) { return x.live; });
  log('open ' + s.slug + ' from ' + r.id);
  Player.open(live, live.indexOf(s), function (last) {
    // Back in the grid: focus the channel we ended up on, if it's in this row.
    var at = r.items.indexOf(last);
    if (at >= 0) scrollTo(r, at);
    updateFocus(true);
    refresh();
  });
}

function launchApp(a) {
  log('launch ' + a.name);
  fetch(SERVICE + '/launch?id=' + encodeURIComponent(a.id), { method: 'POST' })
    .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t); }); })
    .then(function (r) { if (r.dev) Toast.show({ text: a.name + ' TV\'de açılırdı (Mac\'te çalışıyor).' }); })
    .catch(function (e) {
      Toast.show({ kind: 'app', text: a.name + ' açılamadı.', level: 'error', sound: true, avatar: a.icon ? SERVICE + a.icon : undefined });
      log('launch failed: ' + e);
    });
}

function toggleFavourite() {
  var r = rows[focusRow];
  var s = r && r.items[r.col];
  if (!s || s.kind !== 'stream') return;
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
  // OK or Back first dismisses a boss alert, over the home screen and the player alike.
  if (Toast.bossOpen() && (name === 'ENTER' || name === 'BACK')) { Toast.closeBoss(); return; }
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
      if (!l[0] || !l[0].live) { Toast.show({ text: parts[1] + ' şu an yayında değil.', level: 'warn', sound: true }); return; }
      if (Player.isOpen()) Player.close();
      Player.open(l, 0, function () { updateFocus(true); refresh(); });
    });
  } else if (parts[0] === 'reload') location.reload();
  else if (parts[0] === 'refresh') refresh();
  else if (parts[0] === 'sleep') {
    if (Player.isOpen()) Player.close();
    Toast.show({ text: 'İyi geceler 🌙', seconds: 8 });
    updateFocus(true);
  }
  else log('unknown command: ' + cmd);
}

function poll() {
  api('/cmd').then(function (l) { l.forEach(runCommand); }).catch(function () {});
  api('/notify').then(function (l) { l.forEach(function (n) { Toast.show(n); }); }).catch(function () {});
}

// ---- updates: reload when a newer version is published and nobody is watching

// GitHub's raw files are at most 5 minutes old; jsDelivr's @main can be hours behind.
var VERSION_URL = 'https://raw.githubusercontent.com/ANKA-CORP/anka-tv-module/main/version.json';
// tools/publish.sh writes the published version here.
var PAGE_VERSION = '0.75.0';

// The number in "0.34.0": publishes only count up.
function versionNumber(v) { return parseInt(String(v).split('.')[1], 10) || 0; }

// version.json can be a few minutes behind the code, so only a newer number reloads the page.
function checkVersion() {
  fetch(VERSION_URL + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (v && versionNumber(v.version) > versionNumber(PAGE_VERSION) && !Player.isOpen()) {
      log('new version ' + v.version + ', reloading');
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
  loadWeather();
  setInterval(loadWeather, 15 * 60000);
  Splash.begin();
  makeEmbers();
  // At most 6 s of splash, even if Kick is slow; the rows show their own placeholders.
  setTimeout(Splash.end, 6000);
  Player.init();
  Player.onChange(reportState);
  renderSkeleton();
  log('app started: ' + navigator.userAgent + ' · tizen: ' + typeof window.tizen + ' · webapis: ' + typeof window.webapis);
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(renderWidgets, 30000);
  setInterval(poll, 1500);
  setInterval(reportState, 5000);
  // Only on the TV, where TizenBrew serves the published version (on port 8081).
  if (location.port === '8081') {
    $('version').textContent = 'v' + PAGE_VERSION;
    log('version ' + PAGE_VERSION);
    checkVersion();
    setInterval(checkVersion, 3 * 60000);
  } else {
    $('version').textContent = 'dev';
  }
}

main();

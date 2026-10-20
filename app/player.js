// Full-screen player: hls.js on the master playlist the service fetches (Kick's CORS keeps the page from it).
// Recovers by itself from errors and stalls, which the spike showed happen now and then.
'use strict';

var Player = (function () {
  var root, video, spinner, msg, osd, flash;
  var hls = null;
  var list = [];          // the live streams of the row the player was opened from
  var index = 0;
  var onClose = null;
  var levelChoice = -1;   // -1 = automatic
  var osdTimer = null, flashTimer = null, watchdog = null;
  var lastTime = 0, lastProgressAt = 0, loadedAt = 0;
  var retries = 0, mediaRecoveries = 0, reloadTimer = null;

  function $(id) { return document.getElementById(id); }

  function init() {
    root = $('player'); video = $('video'); spinner = $('spinner'); msg = $('player-msg'); osd = $('osd'); flash = $('channel-flash');
    video.addEventListener('playing', function () {
      spinner.classList.remove('on');
      msg.textContent = '';
      log('player: playing ' + current().slug + ' (' + qualityLabel() + ')');
    });
    video.addEventListener('waiting', function () { spinner.classList.add('on'); });
  }

  function current() { return list[index]; }
  function isOpen() { return root.classList.contains('open'); }

  function open(streams, i, closeCb) {
    list = streams;
    index = i;
    onClose = closeCb;
    root.classList.add('open');
    start();
  }

  function close() {
    stop();
    root.classList.remove('open');
    osd.classList.remove('on');
    if (onClose) onClose(current());
  }

  function stop() {
    clearInterval(watchdog);
    clearTimeout(reloadTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
  }

  function start() {
    stop();
    retries = 0;
    mediaRecoveries = 0;
    levelChoice = -1;
    showOsd(5000);
    load();
  }

  function load() {
    var s = current();
    spinner.classList.add('on');
    if (!window.Hls || !Hls.isSupported()) { msg.textContent = 'Bu cihazda oynatıcı çalışmıyor (hls.js).'; return; }
    hls = new Hls({
      // The TV has little memory: keep the buffers modest and drop what's been played.
      maxBufferLength: 20,
      maxBufferSize: 30 * 1000 * 1000,
      backBufferLength: 10,
      liveSyncDurationCount: 3,
      // Assume a good home connection (5 Mbps) so playback starts around 720p, not 160p.
      abrEwmaDefaultEstimate: 5000000
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (levelChoice >= 0) hls.currentLevel = levelChoice;
      video.play().catch(function (e) { log('player: play() ' + e); });
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, function () { renderQuality(); });
    hls.on(Hls.Events.ERROR, function (e, d) {
      if (!d.fatal) return;
      log('player: fatal ' + d.type + ' ' + d.details + (d.response ? ' http ' + d.response.code : ''));
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
        mediaRecoveries++;
        hls.recoverMediaError();
        return;
      }
      reload('error ' + d.details);
    });
    // A fresh master playlist each time: its token expires after about ten minutes.
    hls.loadSource(SERVICE + '/master.m3u8?slug=' + encodeURIComponent(s.slug) + '&t=' + Date.now());
    hls.attachMedia(video);

    lastTime = 0;
    lastProgressAt = loadedAt = Date.now();
    clearInterval(watchdog);
    watchdog = setInterval(checkProgress, 2000);
  }

  // If the picture hasn't moved for 10 s while it should play, start over.
  function checkProgress() {
    if (video.paused && !spinner.classList.contains('on')) { lastProgressAt = Date.now(); return; }
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastProgressAt = Date.now();
      // Half a minute of steady playback forgives earlier retries.
      if (retries && Date.now() - loadedAt > 30000) retries = 0;
      return;
    }
    if (Date.now() - lastProgressAt > 10000) reload('stalled at ' + video.currentTime.toFixed(1));
  }

  function reload(reason) {
    clearInterval(watchdog);
    if (hls) { hls.destroy(); hls = null; }
    retries++;
    log('player: reload #' + retries + ' (' + reason + ')');
    if (retries > 5) {
      spinner.classList.remove('on');
      msg.textContent = 'Yayın şu an açılmıyor. Yayıncı yayını kapatmış olabilir.';
      return;
    }
    if (retries === 3) Toast.show({ text: 'Yayına yeniden bağlanılıyor…', level: 'warn' });
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, Math.min(1500 * retries, 8000));
  }

  function switchChannel(step) {
    if (list.length < 2) return;
    index = (index + step + list.length) % list.length;
    flash.textContent = (index + 1) + ' / ' + list.length + '  ·  ' + current().name;
    flash.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash.classList.remove('on'); }, 1500);
    start();
  }

  // Automatic first, then each quality from best to worst.
  function cycleQuality(step) {
    if (!hls || !hls.levels.length) return;
    var order = [-1];
    hls.levels.map(function (l, i) { return i; })
      .sort(function (a, b) { return hls.levels[b].height - hls.levels[a].height || hls.levels[b].bitrate - hls.levels[a].bitrate; })
      .forEach(function (i) { order.push(i); });
    var pos = order.indexOf(levelChoice);
    levelChoice = order[(pos + step + order.length) % order.length];
    hls.currentLevel = levelChoice;
    log('player: quality ' + (levelChoice < 0 ? 'auto' : levelName(hls.levels[levelChoice])));
    renderQuality();
    showOsd(4000);
  }

  function levelName(l) {
    if (!l) return '';
    var fps = parseFloat(l.attrs && l.attrs['FRAME-RATE']) || 0;
    return l.height + 'p' + (fps > 45 ? '60' : '');
  }

  function qualityLabel() {
    if (!hls) return '';
    var playing = levelName(hls.levels[hls.currentLevel]);
    return levelChoice < 0 ? 'Otomatik' + (playing ? ' · ' + playing : '') : playing;
  }

  function renderQuality() { $('osd-quality').textContent = qualityLabel(); }

  function renderOsd() {
    var s = current();
    var name = $('osd-name');
    name.innerHTML = '';
    if (s.avatar) { var img = el('img'); img.src = s.avatar; name.appendChild(img); }
    name.appendChild(document.createTextNode(s.name));
    name.appendChild(el('span', 'pill live', 'CANLI'));
    $('osd-title').textContent = s.title;
    $('osd-meta').textContent = metaLine(s);
    renderQuality();
  }

  function showOsd(ms) {
    renderOsd();
    osd.classList.add('on');
    clearTimeout(osdTimer);
    if (ms) osdTimer = setTimeout(function () { osd.classList.remove('on'); }, ms);
  }

  function togglePause() {
    if (video.paused) {
      // Back to the live edge, not where we paused.
      if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
      video.play().catch(function () {});
      showOsd(3000);
    } else {
      video.pause();
      showOsd(0);
    }
  }

  function handleKey(name) {
    if (name === 'BACK') close();
    else if (name === 'UP' || name === 'CH_UP') switchChannel(-1);
    else if (name === 'DOWN' || name === 'CH_DOWN') switchChannel(1);
    else if (name === 'LEFT') cycleQuality(-1);
    else if (name === 'RIGHT') cycleQuality(1);
    else if (name === 'ENTER') { if (osd.classList.contains('on')) osd.classList.remove('on'); else showOsd(5000); }
    else if (name === 'PLAY_PAUSE') togglePause();
  }

  return { init: init, open: open, close: close, isOpen: isOpen, handleKey: handleKey, current: current };
})();

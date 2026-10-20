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
  var changed = function () {};   // set by the app: called when the channel, quality or open state changes

  function $(id) { return document.getElementById(id); }

  function init() {
    root = $('player'); video = $('video'); spinner = $('spinner'); msg = $('player-msg'); osd = $('osd'); flash = $('channel-flash');
    video.addEventListener('playing', function () {
      spinner.classList.remove('on');
      msg.textContent = '';
      log('player: playing ' + current().slug + ' (' + qualityLabel() + ')');
      changed();
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
    changed();
  }

  function stop() {
    closePanel();
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
    hls.on(Hls.Events.LEVEL_SWITCHED, function () { renderQuality(); changed(); });
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

  // ---- quality panel: a side list, like Android TV's, instead of cycling blind

  var panelOpen = false, panelOptions = [], panelIndex = 0;

  // Automatic first, then each quality from best to worst.
  function qualityOptions() {
    var order = [-1];
    hls.levels.map(function (l, i) { return i; })
      .sort(function (a, b) { return hls.levels[b].height - hls.levels[a].height || hls.levels[b].bitrate - hls.levels[a].bitrate; })
      .forEach(function (i) { order.push(i); });
    return order;
  }

  function openPanel() {
    if (!hls || !hls.levels.length) return;
    panelOptions = qualityOptions();
    panelIndex = Math.max(0, panelOptions.indexOf(levelChoice));
    panelOpen = true;
    osd.classList.remove('on');
    renderPanel();
    $('qpanel').classList.add('on');
  }

  function closePanel() {
    panelOpen = false;
    $('qpanel').classList.remove('on');
  }

  function renderPanel() {
    var list = $('qlist');
    list.innerHTML = '';
    panelOptions.forEach(function (lvl, i) {
      var item = el('div', 'qitem' + (i === panelIndex ? ' focused' : ''));
      if (lvl < 0) {
        item.appendChild(el('b', '', 'Otomatik'));
        var now = levelName(hls.levels[hls.currentLevel]);
        item.appendChild(el('small', '', 'Bağlantına göre ayarlanır' + (levelChoice < 0 && now ? ' · şu an ' + now : '')));
      } else {
        var l = hls.levels[lvl];
        item.appendChild(el('b', '', levelName(l) + (i === 1 ? ' · Kaynak' : '')));
        item.appendChild(el('small', '', (l.bitrate / 1000000).toFixed(1).replace('.', ',') + ' Mbps'));
      }
      if (lvl === levelChoice) item.appendChild(el('span', 'check', '✓'));
      list.appendChild(item);
    });
  }

  function choose(lvl) {
    levelChoice = lvl;
    hls.currentLevel = lvl;
    log('player: quality ' + (lvl < 0 ? 'auto' : levelName(hls.levels[lvl])));
    closePanel();
    showOsd(3000);
    changed();
  }

  function handlePanelKey(name) {
    if (name === 'UP') panelIndex = Math.max(0, panelIndex - 1);
    else if (name === 'DOWN') panelIndex = Math.min(panelOptions.length - 1, panelIndex + 1);
    else if (name === 'ENTER') return choose(panelOptions[panelIndex]);
    else if (name === 'BACK' || name === 'LEFT') return closePanel();
    renderPanel();
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
    name.appendChild(el('span', 'pill live', 'Canlı'));
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
    if (panelOpen) return handlePanelKey(name);
    if (name === 'BACK') close();
    else if (name === 'UP' || name === 'CH_UP') switchChannel(-1);
    else if (name === 'DOWN' || name === 'CH_DOWN') switchChannel(1);
    else if (name === 'LEFT' || name === 'RIGHT') openPanel();
    else if (name === 'ENTER') { if (osd.classList.contains('on')) osd.classList.remove('on'); else showOsd(5000); }
    else if (name === 'PLAY_PAUSE') togglePause();
  }

  return {
    init: init, open: open, close: close, isOpen: isOpen, handleKey: handleKey, current: current,
    quality: qualityLabel,
    onChange: function (cb) { changed = cb; }
  };
})();

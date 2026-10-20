// The opening: the phoenix mark rises while embers drift up from the bottom, until the first rows are in.
// Drawn on a half-size canvas and stopped right after, so the TV's GPU only pays for it once.
'use strict';

var Splash = (function () {
  var root, canvas, ctx, raf = 0, startedAt = 0, ending = false;
  var embers = [];
  var W = 960, H = 540;
  var MIN_MS = 1400;

  function spawn(e) {
    e.x = W / 2 + (Math.random() - 0.5) * W * 0.9;
    e.y = H + Math.random() * 60;
    e.vy = 0.6 + Math.random() * 1.6;
    e.r = 0.8 + Math.random() * 2.4;
    e.phase = Math.random() * Math.PI * 2;
    return e;
  }

  function tick(t) {
    ctx.clearRect(0, 0, W, H);
    var alive = 0;
    for (var i = 0; i < embers.length; i++) {
      var e = embers[i];
      e.y -= e.vy;
      e.x += Math.sin(t / 500 + e.phase) * 0.35;
      if (e.y < -10) { if (ending) continue; spawn(e); }
      alive++;
      // Embers cool as they rise: bright near the ground, fading towards the top.
      var heat = Math.max(0, Math.min(1, e.y / H));
      ctx.globalAlpha = 0.15 + 0.85 * heat;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (0.6 + heat * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    if (alive) raf = requestAnimationFrame(tick);
  }

  function begin() {
    root = document.getElementById('splash');
    canvas = document.getElementById('embers');
    startedAt = Date.now();
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff8a3d';
    for (var i = 0; i < 70; i++) {
      var e = spawn({});
      e.y = Math.random() * H;   // start mid-flight so the first frame isn't empty
      embers.push(e);
    }
    raf = requestAnimationFrame(tick);
  }

  // Called when the home screen has data; the splash stays at least MIN_MS so it never just flickers.
  function end() {
    if (!root || ending) return;
    ending = true;
    setTimeout(function () {
      root.classList.add('done');
      setTimeout(function () {
        cancelAnimationFrame(raf);
        if (root.parentNode) root.parentNode.removeChild(root);
      }, 700);
    }, Math.max(0, MIN_MS - (Date.now() - startedAt)));
  }

  return { begin: begin, end: end };
})();

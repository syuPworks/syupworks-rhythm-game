'use strict';
/* syuP音ゲー Ver.2 — result celebration effects.
 * A short-lived particle show drawn on its own canvas over the result screen. It only runs on the result screen,
 * stops by itself after a few seconds (no endless emitters), and ResultFX.stop() tears it down immediately.
 *   level 0  nothing (failed / game over)        level 3  + petals, second confetti wave, glowing frame
 *   level 1  a few twinkles                       level 4  + fireworks and a golden star shower
 *   level 2  + one confetti burst                 level 5  ALL PERFECT: prismatic everything
 * opts: { lite, reduced, fullCombo, unlock, anchors: { kind, rank } }
 */
window.ResultFX = (() => {
  const PALETTES = {
    normal: ['#62e8ff', '#638dff', '#af78ff', '#ff79bf', '#ffd95a', '#ffffff'],
    gold: ['#ffd95a', '#ffe9a3', '#fff6c8', '#ffb347', '#ffffff'],
    prism: ['#ff5d8a', '#ffb347', '#ffd95a', '#5aefc2', '#57e6ff', '#638dff', '#c48cff', '#ffffff'],
    unlock: ['#c48cff', '#ff7bd8', '#7fe8ff', '#ffffff']
  };
  let canvas = null, ctx = null, raf = 0, parts = [], timeline = [], startAt = 0, dpr = 1, W = 0, H = 0, cap = 300, lastFrame = 0, top = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const center = el => { const r = el?.getBoundingClientRect(); return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight * 0.3 }; };

  function ensureCanvas() {
    if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'result-fx'; canvas.setAttribute('aria-hidden', 'true'); document.body.appendChild(canvas); ctx = canvas.getContext('2d'); }
    dpr = Math.min(1.5, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight; top = safeTop();
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.hidden = false;
  }
  // phones with a notch / Dynamic Island: bursts start below the status-bar area, not hidden under it
  function safeTop() {
    const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe); const h = probe.getBoundingClientRect().height || 0; probe.remove(); return h;
  }
  // Safari's address bar showing / hiding resizes the viewport: follow it while the show is running
  function onResize() { if (raf && canvas) ensureCanvas(); }
  window.addEventListener('resize', onResize); window.visualViewport?.addEventListener('resize', onResize);
  function add(p) { if (parts.length < cap) parts.push(p); }

  // ── emitters
  function confetti(x, y, count, palette, spread = 1) {
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI * 0.95, -Math.PI * 0.05) * spread + (spread < 1 ? -Math.PI / 2 * (1 - spread) : 0), v = rand(260, 620);
      add({ k: 'confetti', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: rand(6, 11), h: rand(3, 6), rot: rand(0, 6.3), vr: rand(-9, 9), flip: rand(0, 6.3), color: pick(palette), life: rand(2.6, 4), age: 0 });
    }
  }
  function petals(count, palette) {
    for (let i = 0; i < count; i++) add({ k: 'petal', x: rand(-0.05, 1.05) * W, y: rand(-0.25, -0.02) * H, vx: rand(-30, 40), vy: rand(45, 95), size: rand(5, 9), rot: rand(0, 6.3), vr: rand(-1.5, 1.5), sway: rand(0, 6.3), color: pick(palette), life: rand(5, 7.5), age: -rand(0, 2.2) });
  }
  function twinkles(cx, cy, count, palette, radius) {
    for (let i = 0; i < count; i++) add({ k: 'star', x: cx + rand(-radius, radius), y: cy + rand(-radius * 0.45, radius * 0.45), vx: 0, vy: rand(-14, -4), size: rand(4, 9), color: pick(palette), life: rand(1.2, 2.2), age: -rand(0, 1.6) });
  }
  function firework(x, y, count, palette) {
    const color = pick(palette);
    for (let i = 0; i < count; i++) { const a = (i / count) * Math.PI * 2 + rand(-0.05, 0.05), v = rand(160, 300); add({ k: 'spark', x, y, px: x, py: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: Math.random() < 0.25 ? '#ffffff' : color, life: rand(1.1, 1.7), age: 0 }); }
    add({ k: 'flash', x, y, size: 70, color, life: 0.35, age: 0 });
  }
  // CHAOS: little smiling notes and dice tumbling down
  function party(count) {
    for (let i = 0; i < count; i++) add({ k: Math.random() < 0.5 ? 'face' : 'die', x: rand(0.05, 0.95) * W, y: rand(-0.4, -0.05) * H, vx: rand(-40, 40), vy: rand(110, 210), size: rand(10, 18), rot: rand(0, 6.3), vr: rand(-4, 4), color: pick(PALETTES.normal), life: rand(3, 4.5), age: -rand(0, 1.5) });
  }
  function shower(count, palette) {
    for (let i = 0; i < count; i++) add({ k: 'star', x: rand(0.05, 0.95) * W, y: rand(-0.3, -0.02) * H, vx: rand(-20, 20), vy: rand(120, 220), size: rand(5, 10), color: pick(palette), life: rand(2.5, 3.6), age: -rand(0, 1.2), fall: true });
  }

  // ── drawing
  function starPath(x, y, r) { ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); }
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016); lastFrame = now;
    const elapsed = now - startAt;
    while (timeline.length && timeline[0].at <= elapsed) timeline.shift().fn();
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.age += dt; if (p.age < 0) continue;
      const k = p.age / p.life, fade = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
      if (p.k === 'confetti') {
        p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) + 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.flip += 8 * dt;
        ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.flip)); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      } else if (p.k === 'petal') {
        p.sway += dt * 1.6; p.x += (p.vx + Math.sin(p.sway) * 35) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        ctx.save(); ctx.globalAlpha = 0.85 * fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.moveTo(0, -p.size); ctx.quadraticCurveTo(p.size * 0.9, 0, 0, p.size); ctx.quadraticCurveTo(-p.size * 0.9, 0, 0, -p.size); ctx.fill(); ctx.restore();
      } else if (p.k === 'star') {
        p.x += p.vx * dt; p.y += p.vy * dt;
        const tw = p.fall ? 1 : Math.sin(Math.min(1, k) * Math.PI);
        ctx.save(); ctx.globalAlpha = Math.max(0, tw * fade); ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8; starPath(p.x, p.y, p.size * (0.6 + 0.4 * tw)); ctx.fill(); ctx.restore();
      } else if (p.k === 'face' || p.k === 'die') {
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); const r = p.size;
        if (p.k === 'face') { ctx.fillStyle = p.color; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#1b2440'; ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.08, r * 0.1, 0, 6.3); ctx.arc(r * 0.35, -r * 0.08, r * 0.1, 0, 6.3); ctx.fill(); ctx.strokeStyle = '#1b2440'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, r * 0.05, r * 0.22, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); }
        else { ctx.fillStyle = '#ffffff'; ctx.fillRect(-r * 0.6, -r * 0.6, r * 1.2, r * 1.2); ctx.fillStyle = '#1b2440'; for (const [dx, dy] of [[-0.3, -0.3], [0, 0], [0.3, 0.3]]) { ctx.beginPath(); ctx.arc(dx * r, dy * r, r * 0.1, 0, 6.3); ctx.fill(); } }
        ctx.restore();
      } else if (p.k === 'spark') {
        p.px = p.x; p.py = p.y; p.vx *= 1 - 1.2 * dt; p.vy = p.vy * (1 - 1.2 * dt) + 140 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.globalAlpha = fade; ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (p.k === 'flash') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * (0.5 + k)); g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1 - k; ctx.fillStyle = g; ctx.fillRect(p.x - p.size * 2, p.y - p.size * 2, p.size * 4, p.size * 4); ctx.globalAlpha = 1;
      }
    }
    parts = parts.filter(p => p.age < p.life && p.y < H + 60 && p.x > -80 && p.x < W + 80);
    if (parts.length || timeline.length) raf = requestAnimationFrame(frame); else stop();
  }

  function start(level, opts = {}) {
    stop();
    if (level <= 0 || opts.reduced) return;
    level = Math.max(level, opts.party || opts.bloom ? 2 : 0);                        // reduced motion: the CSS glow alone carries the mood
    ensureCanvas();
    const lite = !!opts.lite, n = x => Math.max(1, Math.round(x * (lite ? 0.35 : 1)));
    cap = lite ? 110 : 340;
    const pal = level >= 5 ? PALETTES.prism : opts.fullCombo || level >= 4 ? PALETTES.gold : PALETTES.normal;
    const kind = center(opts.anchors?.kind), rank = center(opts.anchors?.rank);
    const at = (ms, fn) => timeline.push({ at: ms, fn });
    at(150, () => twinkles(kind.x, kind.y, n(level >= 3 ? 22 : 12), level >= 5 ? PALETTES.prism : PALETTES.gold, 160));
    if (level >= 2) at(300, () => { confetti(W * 0.04, top + H * 0.06, n(level >= 4 ? 60 : 38), pal); confetti(W * 0.96, top + H * 0.06, n(level >= 4 ? 60 : 38), pal); });
    if (level >= 3) { at(1100, () => confetti(W * 0.5, -10, n(50), pal, 0.35)); at(500, () => petals(n(level >= 5 ? 60 : 38), level >= 5 ? PALETTES.prism : ['#ffd1e6', '#ffb3d6', '#ffffff', '#ffe9f3'])); }
    if (level >= 4) { [600, 1300, 2000].forEach((ms, i) => at(ms, () => firework(W * (0.22 + 0.28 * i), top + (H - top) * rand(0.18, 0.32), n(46), pal))); at(900, () => shower(n(40), PALETTES.gold)); }
    if (level >= 5) { [2600, 3100, 3600].forEach((ms, i) => at(ms, () => firework(W * (0.3 + 0.2 * i), top + (H - top) * rand(0.15, 0.28), n(56), PALETTES.prism))); at(2300, () => confetti(W * 0.5, H, n(70), PALETTES.prism, 1)); }
    if (opts.party) { at(700, () => party(n(36))); at(2200, () => party(n(24))); }
    if (opts.bloom) { at(400, () => petals(n(70), ['#ffd1e6', '#ffb3d6', '#ffffff', '#ffe9a3', '#c9ffef'])); at(800, () => twinkles(rank.x, rank.y, n(20), PALETTES.gold, 140)); }
    if (opts.unlock) at(1500, () => { firework(rank.x, rank.y, n(40), PALETTES.unlock); twinkles(rank.x, rank.y, n(16), PALETTES.unlock, 120); });
    timeline.sort((a, b) => a.at - b.at);
    startAt = lastFrame = performance.now(); raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf); raf = 0; parts = []; timeline = [];
    if (ctx) ctx.clearRect(0, 0, W, H);
    if (canvas) canvas.hidden = true;
  }
  const isRunning = () => !!raf;
  const particleCount = () => parts.length;
  return { start, stop, isRunning, particleCount };
})();

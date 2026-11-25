/* =========================================================
   GONGUINHO E MARIA BOLINHA - mini jogo 2D
   Toque/clique e SEGURE: quanto mais tempo segurar, mais alto pulam.
   Pule os ratos, cuidado com os obstáculos de cima e pegue moedas!
   ========================================================= */
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = 960, H = 540;
  const GROUND = 462;          // linha do chão (pés)
  const COUPLE_H = 112;        // altura dos personagens na tela
  const FONT = '"Press Start 2P", monospace';

  // ---------- Física ----------
  const GRAVITY = 2600;
  const JUMP_V = 700;          // impulso inicial (toque rápido = pulo baixo)
  const HOLD_MAX = 0.32;       // tempo máximo segurando que ainda aumenta o pulo
  const HOLD_GRAVITY = 0.3;    // gravidade reduzida enquanto segura
  const START_SPEED = 380;
  const MAX_SPEED = 820;

  // ---------- Cores ----------
  const RED = '#e0001b', RED_D = '#8a0010', RED_L = '#ff3347';
  const PINK = '#ff6fb5', BLACK = '#000', GOLD = '#ffcc00';

  // ---------- Armazenamento (opcional) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  let best = store.get('gmb_best', 0);
  let totalCoins = store.get('gmb_coins', 0);
  let muted = store.get('gmb_muted', false);

  // ---------- Imagens ----------
  const SRC = { maria: 'assets/maria.png', gong: 'assets/gonguinho.png', rato: 'assets/rato.png' };
  const IMG = {};
  const SPR = {};   // sprites pré-redimensionados

  function loadImages() {
    return Promise.all(Object.entries(SRC).map(([k, src]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { IMG[k] = im; res(); };
      im.onerror = () => { IMG[k] = null; res(); };
      im.src = src;
    })));
  }

  // Redimensiona com qualidade uma única vez (fica nítido e leve)
  function makeSprite(img, h) {
    if (!img) return null;
    const w = Math.round(img.width * h / img.height);
    let c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return c;
  }
  function flipSprite(spr) {
    const c = document.createElement('canvas');
    c.width = spr.width; c.height = spr.height;
    const g = c.getContext('2d');
    g.translate(spr.width, 0); g.scale(-1, 1);
    g.drawImage(spr, 0, 0);
    return c;
  }

  function buildSprites() {
    SPR.maria = makeSprite(IMG.maria, COUPLE_H);
    SPR.gong = makeSprite(IMG.gong, COUPLE_H + 2);
    SPR.ratos = {};
    // rato virado para a esquerda (vindo na direção do casal)
    const base = makeSprite(IMG.rato, 90);
    SPR.ratoBig = base ? flipSprite(base) : null;
    SPR.ratoTitle = makeSprite(IMG.rato, 150);
  }
  function ratSprite(h) {
    if (!IMG.rato) return null;
    if (!SPR.ratos[h]) SPR.ratos[h] = flipSprite(makeSprite(IMG.rato, h));
    return SPR.ratos[h];
  }

  // ---------- Áudio (bipes estilo 8-bit) ----------
  let actx = null;
  function audio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function beep(freq, dur, type = 'square', slideTo = null, vol = 0.12, delay = 0) {
    if (muted) return;
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const sfx = {
    jump() { beep(330, 0.16, 'square', 700, 0.08); },
    coin() { beep(988, 0.07, 'square', null, 0.08); beep(1319, 0.14, 'square', null, 0.08, 0.07); },
    hit() { beep(220, 0.4, 'sawtooth', 55, 0.15); beep(110, 0.5, 'square', 40, 0.1, 0.05); },
    start() { [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.1, 'square', null, 0.08, i * 0.08)); },
    record() { [784, 988, 1175, 1568].forEach((f, i) => beep(f, 0.12, 'triangle', null, 0.12, i * 0.1)); },
    pass() { beep(660, 0.05, 'triangle', 880, 0.05); }
  };

  // ---------- Estado ----------
  let state = 'loading';
  let time = 0;
  let speed = START_SPEED;
  let distance = 0;
  let score = 0;
  let coins = 0;
  let ratsJumped = 0;
  let overTimer = 0;
  let newRecord = false;
  let shake = 0;
  let flash = 0;
  let nextSpawn = 0;
  let groundOffset = 0;

  const player = {
    x: 150, y: GROUND, vy: 0, onGround: true,
    jumping: false, holdT: 0, power: 0, buffer: 0, landSquash: 0
  };
  let holding = false;

  let rats = [], ceilings = [], coinList = [], particles = [], popups = [];

  // ---------- Cenário (parallax) ----------
  function makeSkyline(count, minH, maxH, minW, maxW, seed) {
    let s = seed;
    const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const arr = []; let x = 0;
    for (let i = 0; i < count; i++) {
      const w = Math.round(minW + rnd() * (maxW - minW));
      const h = Math.round(minH + rnd() * (maxH - minH));
      const wins = [];
      for (let wy = 10; wy < h - 10; wy += 16) {
        for (let wx = 8; wx < w - 8; wx += 14) {
          if (rnd() < 0.35) wins.push([wx, wy, rnd() < 0.2]);
        }
      }
      arr.push({ x, w, h, wins });
      x += w + Math.round(rnd() * 14);
    }
    return { list: arr, width: x };
  }
  const farCity = makeSkyline(30, 90, 220, 50, 110, 7);
  const nearCity = makeSkyline(24, 60, 150, 70, 140, 42);
  const stars = Array.from({ length: 70 }, (_, i) => ({
    x: (i * 137.5) % W, y: (i * 61.3) % 260, s: i % 5 === 0 ? 3 : 2, p: i * 0.7
  }));

  // ---------- Entrada ----------
  function toGame(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }
  const MUTE_BTN = { x: W - 62, y: H - 52, w: 48, h: 40 };

  function press(pos) {
    audio();
    if (pos && pos.x >= MUTE_BTN.x && pos.x <= MUTE_BTN.x + MUTE_BTN.w &&
        pos.y >= MUTE_BTN.y && pos.y <= MUTE_BTN.y + MUTE_BTN.h) {
      muted = !muted; store.set('gmb_muted', muted);
      return;
    }
    holding = true;
    if (state === 'title') { startGame(); return; }
    if (state === 'over') {
      if (overTimer > 0.7) startGame();
      return;
    }
    if (state === 'play') tryJump();
  }
  function release() {
    holding = false;
  }

  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); press(toGame(e)); });
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat) press(null);
    } else if (e.code === 'KeyM') {
      muted = !muted; store.set('gmb_muted', muted);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Enter') release();
  });
  window.addEventListener('blur', release);

  function tryJump() {
    if (player.onGround) {
      player.vy = -JUMP_V;
      player.onGround = false;
      player.jumping = true;
      player.holdT = 0;
      player.power = 0;
      sfx.jump();
      dust(player.x + 60, GROUND, 6);
    } else {
      player.buffer = 0.12; // pulo antecipado: pula assim que encostar no chão
    }
  }

  // ---------- Jogo ----------
  function startGame() {
    state = 'play';
    speed = START_SPEED;
    distance = 0; score = 0; coins = 0; ratsJumped = 0;
    rats = []; ceilings = []; coinList = []; particles = []; popups = [];
    player.y = GROUND; player.vy = 0; player.onGround = true; player.jumping = false;
    player.holdT = 0; player.power = 0; player.buffer = 0;
    nextSpawn = 520;
    newRecord = false;
    sfx.start();
  }

  function gameOver() {
    state = 'over';
    overTimer = 0;
    shake = 0.45; flash = 0.25;
    sfx.hit();
    totalCoins += coins; store.set('gmb_coins', totalCoins);
    if (score > best) { best = score; newRecord = true; store.set('gmb_best', best); setTimeout(sfx.record, 500); }
    for (let i = 0; i < 26; i++) {
      particles.push({
        x: player.x + 60, y: player.y - 60, vx: (Math.random() - 0.5) * 600, vy: -Math.random() * 600,
        life: 0.9, max: 0.9, size: 6, color: Math.random() < 0.5 ? RED_L : PINK, g: 1400
      });
    }
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function addRat(x, h) {
    const spr = ratSprite(h);
    const w = spr ? spr.width : Math.round(h * 0.73);
    rats.push({ x, h, w, passed: false, bob: Math.random() * 6 });
  }
  function addCeiling(x, w, clear) {
    // "clear" = espaço livre acima da cabeça do casal (em pé)
    const bottom = GROUND - COUPLE_H - clear;
    ceilings.push({ x, w, bottom });
  }
  function addCoin(x, y) { coinList.push({ x, y, t: Math.random() * 6, got: false }); }
  function coinRow(x, y, n) { for (let i = 0; i < n; i++) addCoin(x + i * 40, y); }
  function coinArc(x, n, peak) {
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0.5 : i / (n - 1);
      addCoin(x + i * 38, GROUND - 40 - Math.sin(k * Math.PI) * peak);
    }
  }

  function spawnPattern() {
    const lvl = Math.min(1, distance / 14000);          // 0 → 1 dificuldade
    const x = W + 60;
    const roll = Math.random();
    let len;

    if (roll < 0.30) {
      // Rato sozinho + arco de moedas por cima
      const h = Math.round(rand(52, 70 + lvl * 14));
      addRat(x, h);
      coinArc(x - 70, 5, 95 + Math.random() * 60);
      len = 380;
    } else if (roll < 0.48) {
      // Obstáculo de cima sozinho (não pule alto!) + moedas no chão
      const w = Math.round(rand(90, 170));
      addCeiling(x, w, rand(105, 150));
      coinRow(x + 10, GROUND - 40, Math.max(2, Math.floor(w / 40)));
      len = w + 300;
    } else if (roll < 0.70) {
      // Rato com obstáculo em cima: pulo curto/médio
      const h = Math.round(rand(46, 58));
      addRat(x, h);
      const cw = Math.round(rand(120, 180));
      addCeiling(x - cw / 2 + 20, cw, rand(178, 200));
      coinArc(x - 50, 3, 80);
      len = 420;
    } else if (roll < 0.84 && lvl > 0.15) {
      // Dois ratos em sequência
      const h1 = Math.round(rand(50, 66));
      const h2 = Math.round(rand(50, 72));
      const gap = rand(300, 380) + speed * 0.25;
      addRat(x, h1);
      addRat(x + gap, h2);
      coinArc(x + 40, 4, 120);
      len = gap + 360;
    } else if (roll < 0.92 && lvl > 0.35) {
      // Rato grande: segure para pular bem alto
      const h = Math.round(rand(82, 92));
      addRat(x, h);
      coinArc(x - 80, 6, 190);
      len = 420;
    } else {
      // Corredor de moedas com obstáculo alto
      coinRow(x, GROUND - 40, 6);
      if (Math.random() < 0.6) addCeiling(x + 60, 140, rand(110, 140));
      len = 420;
    }
    nextSpawn = len + rand(120, 300) * (1.1 - lvl * 0.4);
  }

  // ---------- Colisões ----------
  function coupleBox() {
    return { x: player.x + 24, y: player.y - COUPLE_H + 12, w: 76, h: COUPLE_H - 14 };
  }
  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------- Partículas ----------
  function dust(x, y, n) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x: x + rand(-30, 30), y, vx: rand(-120, 40), vy: rand(-120, -20),
        life: 0.4, max: 0.4, size: 4, color: '#5a0a12', g: 300
      });
    }
  }
  function sparkle(x, y) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      particles.push({
        x, y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160,
        life: 0.35, max: 0.35, size: 4, color: i % 2 ? GOLD : '#fff6b0', g: 0
      });
    }
  }

  // ---------- Atualização ----------
  function update(dt) {
    time += dt;
    if (shake > 0) shake -= dt;
    if (flash > 0) flash -= dt;

    // partículas sempre
    for (const p of particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt;
    }
    particles = particles.filter(p => p.life > 0);
    for (const p of popups) { p.life -= dt; p.y -= 40 * dt; }
    popups = popups.filter(p => p.life > 0);

    if (state === 'title') { groundOffset += 200 * dt; return; }
    if (state === 'over') { overTimer += dt; return; }
    if (state !== 'play') return;

    speed = Math.min(MAX_SPEED, speed + 9 * dt);
    const dx = speed * dt;
    distance += dx;
    groundOffset += dx;
    score = Math.floor(distance / 25) + coins * 10 + ratsJumped * 5;

    // pulo (segurar = mais alto)
    let g = GRAVITY;
    if (player.jumping && holding && player.vy < 0 && player.holdT < HOLD_MAX) {
      g = GRAVITY * HOLD_GRAVITY;
      player.holdT += dt;
    } else if (player.jumping && !holding) {
      player.holdT = HOLD_MAX; // soltou: não volta a ganhar força
    }
    player.power = Math.min(1, player.holdT / HOLD_MAX);
    if (!player.onGround) {
      player.vy += g * dt;
      player.y += player.vy * dt;
      if (player.y >= GROUND) {
        player.y = GROUND; player.vy = 0; player.onGround = true; player.jumping = false;
        player.landSquash = 0.12;
        dust(player.x + 60, GROUND, 5);
        if (player.buffer > 0) { player.buffer = 0; if (holding) tryJump(); }
      }
    }
    if (player.buffer > 0) player.buffer -= dt;
    if (player.landSquash > 0) player.landSquash -= dt;

    // geração de obstáculos
    nextSpawn -= dx;
    if (nextSpawn <= 0) spawnPattern();

    for (const r of rats) r.x -= dx;
    for (const c of ceilings) c.x -= dx;
    for (const c of coinList) { c.x -= dx; c.t += dt; }
    rats = rats.filter(r => r.x + r.w > -50);
    ceilings = ceilings.filter(c => c.x + c.w > -50);
    coinList = coinList.filter(c => c.x > -50 && !c.got);

    // colisões
    const box = coupleBox();
    for (const r of rats) {
      const rb = { x: r.x + r.w * 0.2, y: GROUND - r.h * 0.78, w: r.w * 0.6, h: r.h * 0.78 };
      if (overlap(box, rb)) { gameOver(); return; }
      if (!r.passed && r.x + r.w < box.x) {
        r.passed = true; ratsJumped++;
        popups.push({ x: player.x + 60, y: player.y - COUPLE_H - 10, text: '+5', color: '#fff', life: 0.7 });
        sfx.pass();
      }
    }
    for (const c of ceilings) {
      const cb = { x: c.x + 4, y: 0, w: c.w - 8, h: c.bottom - 4 };
      if (overlap(box, cb)) { gameOver(); return; }
    }
    for (const c of coinList) {
      const dxC = (box.x + box.w / 2) - c.x, inX = Math.abs(dxC) < box.w / 2 + 14;
      const inY = c.y > box.y - 14 && c.y < box.y + box.h + 14;
      if (inX && inY) {
        c.got = true; coins++;
        sparkle(c.x, c.y);
        popups.push({ x: c.x, y: c.y - 16, text: '+10', color: GOLD, life: 0.6 });
        sfx.coin();
      }
    }
  }

  // ---------- Desenho ----------
  function drawBackground() {
    const grd = ctx.createLinearGradient(0, 0, 0, GROUND);
    grd.addColorStop(0, '#050000');
    grd.addColorStop(0.55, '#2a0008');
    grd.addColorStop(1, '#5c0012');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, GROUND);

    // estrelas piscando
    for (const s of stars) {
      const a = 0.4 + 0.6 * Math.abs(Math.sin(time * 1.5 + s.p));
      ctx.fillStyle = `rgba(255,200,210,${a})`;
      ctx.fillRect(Math.floor(s.x), Math.floor(s.y), s.s, s.s);
    }

    // lua pixelada
    ctx.fillStyle = '#ff3347';
    pixelCircle(800, 110, 44);
    ctx.fillStyle = '#ff6b7a';
    pixelCircle(788, 98, 14);

    drawCity(farCity, 0.15, '#1a0004', '#6b0d1a', GROUND - 20);
    drawCity(nearCity, 0.4, '#0b0002', '#b3001b', GROUND);
  }
  function pixelCircle(cx, cy, r) {
    const p = 4;
    for (let y = -r; y <= r; y += p) {
      const hw = Math.floor(Math.sqrt(r * r - y * y) / p) * p;
      ctx.fillRect(cx - hw, cy + y, hw * 2, p);
    }
  }
  function drawCity(city, factor, body, win, base) {
    const off = (groundOffset * factor) % city.width;
    for (let rep = 0; rep < 3; rep++) {
      for (const b of city.list) {
        const x = Math.floor(b.x - off + rep * city.width);
        if (x > W || x + b.w < 0) continue;
        ctx.fillStyle = body;
        ctx.fillRect(x, base - b.h, b.w, b.h);
        ctx.fillStyle = win;
        for (const [wx, wy, lit] of b.wins) {
          ctx.globalAlpha = lit ? 1 : 0.45;
          ctx.fillRect(x + wx, base - b.h + wy, 6, 8);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawGround() {
    ctx.fillStyle = RED;
    ctx.fillRect(0, GROUND, W, 8);
    ctx.fillStyle = RED_L;
    ctx.fillRect(0, GROUND, W, 3);
    ctx.fillStyle = '#0a0000';
    ctx.fillRect(0, GROUND + 8, W, H - GROUND - 8);
    // tijolos
    const bw = 48, bh = 18;
    const off = groundOffset % bw;
    ctx.fillStyle = '#3d0009';
    for (let row = 0; row < 5; row++) {
      const y = GROUND + 10 + row * bh;
      const shift = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < W + bw; x += bw) {
        ctx.fillRect(Math.floor(x - off + shift), y, bw - 4, bh - 4);
      }
    }
  }

  function drawCouple(x, feetY, t, running, scale = 1) {
    const air = !running;
    const sq = player.landSquash > 0 && state === 'play' ? 1 - player.landSquash * 0.6 : 1;
    const bobM = running ? Math.abs(Math.sin(t * 14)) * 5 : 0;
    const bobG = running ? Math.abs(Math.sin(t * 14 + 1.4)) * 5 : 0;
    const tiltM = running ? Math.sin(t * 14) * 0.05 : (air ? -0.08 : 0);
    const tiltG = running ? Math.sin(t * 14 + 1.4) * 0.05 : (air ? -0.08 : 0);

    // sombra
    if (state !== 'over' || overTimer < 99) {
      const hgt = Math.max(0, GROUND - feetY);
      const sw = Math.max(40, 120 - hgt * 0.3) * scale;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(Math.floor(x + 62 * scale - sw / 2), GROUND + 1, Math.floor(sw), 6);
    }

    const m = SPR.maria, g = SPR.gong;
    const mx = x, gx = x + 40 * scale;

    // mãos dadas (desenhadas atrás para "grudar" os dois)
    const handY = feetY - COUPLE_H * scale * 0.42 - (bobM + bobG) / 2;
    ctx.fillStyle = '#c98552';
    ctx.fillRect(Math.floor(x + 50 * scale), Math.floor(handY), Math.floor(24 * scale), Math.floor(10 * scale));

    drawSprite(m, mx, feetY - bobM, tiltM, sq, scale);
    drawSprite(g, gx, feetY - bobG, tiltG, sq, scale);

    // mãos entrelaçadas por cima
    ctx.fillStyle = '#d9925c';
    ctx.fillRect(Math.floor(x + 54 * scale), Math.floor(handY - 2), Math.floor(14 * scale), Math.floor(12 * scale));
    ctx.fillStyle = '#b8743f';
    ctx.fillRect(Math.floor(x + 58 * scale), Math.floor(handY + 2), Math.floor(6 * scale), Math.floor(3 * scale));

    // coraçãozinho pulsando
    const hs = (Math.sin(t * 6) > 0 ? 3 : 2) * scale;
    drawHeart(x + 61 * scale, feetY - COUPLE_H * scale - 14 * scale - (bobM + bobG) / 2, hs, PINK);
  }
  function drawSprite(spr, x, feetY, tilt, sq, scale) {
    if (!spr) {
      ctx.fillStyle = RED; ctx.fillRect(x, feetY - COUPLE_H * scale, 80 * scale, COUPLE_H * scale); return;
    }
    const w = spr.width * scale, h = spr.height * scale * sq;
    ctx.save();
    ctx.translate(Math.floor(x + w / 2), Math.floor(feetY));
    ctx.rotate(tilt);
    ctx.drawImage(spr, Math.floor(-w / 2), Math.floor(-h), Math.floor(w), Math.floor(h));
    ctx.restore();
  }
  function drawHeart(cx, cy, s, color) {
    const shape = [
      '.XX.XX.',
      'XXXXXXX',
      'XXXXXXX',
      '.XXXXX.',
      '..XXX..',
      '...X...'
    ];
    ctx.fillStyle = color;
    const ox = Math.floor(cx - 3.5 * s), oy = Math.floor(cy - 3 * s);
    shape.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === 'X') ctx.fillRect(ox + i * s, oy + j * s, s, s);
    });
  }

  function drawRats() {
    for (const r of rats) {
      const spr = ratSprite(r.h);
      const hop = Math.abs(Math.sin(time * 10 + r.bob)) * 3;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(Math.floor(r.x + 4), GROUND + 1, Math.floor(r.w - 8), 5);
      if (spr) ctx.drawImage(spr, Math.floor(r.x), Math.floor(GROUND - r.h - hop));
      else { ctx.fillStyle = PINK; ctx.fillRect(r.x, GROUND - r.h, r.w, r.h); }
    }
  }

  function drawCeilings() {
    for (const c of ceilings) {
      const x = Math.floor(c.x), w = Math.floor(c.w), b = Math.floor(c.bottom);
      const bodyB = b - 18;
      // corrente/estrutura
      ctx.fillStyle = '#000';
      ctx.fillRect(x, 0, w, bodyB);
      // listras de aviso vermelho/preto
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 4, 0, w - 8, bodyB - 4); ctx.clip();
      ctx.fillStyle = RED;
      for (let s = -bodyB; s < w + bodyB; s += 28) {
        ctx.beginPath();
        ctx.moveTo(x + s, bodyB); ctx.lineTo(x + s + 14, bodyB);
        ctx.lineTo(x + s + 14 + bodyB, 0); ctx.lineTo(x + s + bodyB, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // borda inferior
      ctx.fillStyle = '#000';
      ctx.fillRect(x, bodyB - 6, w, 6);
      // espinhos pixelados
      const sp = 16;
      for (let sx = x; sx + sp <= x + w + 1; sx += sp) {
        ctx.fillStyle = '#d9d9d9';
        for (let k = 0; k < 4; k++) {
          ctx.fillRect(sx + k * 2, bodyB + k * 4, sp - k * 4, 4);
        }
        ctx.fillStyle = '#7a7a7a';
        for (let k = 0; k < 4; k++) ctx.fillRect(sx + sp / 2, bodyB + k * 4, Math.max(2, sp / 2 - k * 2), 4);
      }
    }
  }

  function drawCoin(x, y, t, size = 1) {
    const spin = Math.abs(Math.cos(t * 4));
    const w = Math.max(2, Math.round(9 * spin)) * 2 * size;
    const h = 22 * size;
    const X = Math.floor(x - w / 2), Y = Math.floor(y - h / 2);
    ctx.fillStyle = '#7a5200';
    ctx.fillRect(X - 2 * size, Y + 2 * size, w + 4 * size, h - 4 * size);
    ctx.fillRect(X, Y, w, h);
    ctx.fillStyle = GOLD;
    ctx.fillRect(X + 2 * size, Y + 2 * size, Math.max(2, w - 4 * size), h - 4 * size);
    if (w > 10 * size) {
      ctx.fillStyle = '#fff3a0';
      ctx.fillRect(X + 4 * size, Y + 4 * size, 3 * size, h - 10 * size);
      ctx.fillStyle = '#c99400';
      ctx.fillRect(Math.floor(x - 1 * size), Y + 6 * size, 3 * size, h - 12 * size);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      text(p.text, p.x, p.y, 14, p.color, 4);
    }
    ctx.globalAlpha = 1;
  }

  // Texto pixelado com contorno preto
  function text(str, x, y, size, color, outline = 6, shadow = 0, shadowColor = '#000') {
    ctx.font = `${size}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;
    if (shadow) {
      ctx.fillStyle = shadowColor;
      ctx.strokeStyle = shadowColor;
      ctx.lineWidth = outline;
      ctx.strokeText(str, x + shadow, y + shadow);
      ctx.fillText(str, x + shadow, y + shadow);
    }
    if (outline) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = outline;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawHUD() {
    // painel
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(10, 10, 300, 68);
    ctx.fillStyle = RED; ctx.fillRect(10, 10, 300, 4); ctx.fillRect(10, 74, 300, 4);
    ctx.textAlign = 'left';
    text('PONTOS', 24, 32, 12, RED_L, 0);
    text(String(score).padStart(6, '0'), 24, 56, 18, '#fff', 0);
    drawCoin(196, 46, time, 1);
    text('x' + coins, 216, 47, 16, GOLD, 0);

    ctx.textAlign = 'right';
    text('RECORDE ' + best, W - 20, 30, 10, PINK, 4);

    // barra de força do pulo
    if (state === 'play' && !player.onGround) {
      const bx = player.x + 10, by = player.y - COUPLE_H - 40, bw = 100, bh = 8;
      ctx.fillStyle = '#000'; ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
      ctx.fillStyle = '#3a0008'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = player.power > 0.85 ? RED_L : PINK;
      ctx.fillRect(bx, by, Math.floor(bw * Math.max(0.12, player.power)), bh);
    }
    drawMuteButton();
  }

  function drawMuteButton() {
    const b = MUTE_BTN;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = RED;
    ctx.fillRect(b.x, b.y, b.w, 3); ctx.fillRect(b.x, b.y + b.h - 3, b.w, 3);
    // alto-falante pixelado
    ctx.fillStyle = '#fff';
    const x = b.x + 10, y = b.y + 12;
    ctx.fillRect(x, y + 4, 6, 8);
    ctx.fillRect(x + 6, y + 2, 4, 12);
    ctx.fillRect(x + 10, y, 4, 16);
    if (muted) {
      ctx.fillStyle = RED_L;
      for (let i = 0; i < 5; i++) { ctx.fillRect(x + 18 + i * 3, y + 2 + i * 3, 3, 3); ctx.fillRect(x + 30 - i * 3, y + 2 + i * 3, 3, 3); }
    } else {
      ctx.fillRect(x + 18, y + 4, 3, 8);
      ctx.fillRect(x + 24, y + 1, 3, 14);
    }
  }

  function drawTitle() {
    drawBackground();
    drawGround();

    // faixa escura atrás do título
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 26, W, 200);
    ctx.fillStyle = RED;
    ctx.fillRect(0, 26, W, 6); ctx.fillRect(0, 220, W, 6);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 32, W, 4); ctx.fillRect(0, 216, W, 4);

    const wob = Math.round(Math.sin(time * 3) * 3);
    ctx.textAlign = 'center';
    text('GONGUINHO E', W / 2, 84 + wob, 46, RED, 12, 8, RED_D);
    text('MARIA BOLINHA', W / 2, 162 - wob, 50, PINK, 12, 8, '#7a1048');

    // corações decorativos
    drawHeart(70, 124, 6, PINK);
    drawHeart(W - 70, 124, 6, RED);

    // personagens
    drawCouple(250, GROUND, time, true, 1.25);
    const rs = SPR.ratoBig;
    if (rs) {
      const hop = Math.abs(Math.sin(time * 6)) * 10;
      ctx.drawImage(rs, 640, GROUND - rs.height - hop);
    }

    // instrução
    if (Math.floor(time * 2) % 2 === 0) {
      text('TOQUE PARA COMEÇAR', W / 2, 256, 20, '#fff', 6);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(W / 2 - 330, 276, 660, 30);
    text('SEGURE PARA PULAR MAIS ALTO', W / 2, 292, 12, PINK, 0);

    ctx.textAlign = 'left';
    text('RECORDE: ' + best, 20, H - 40, 12, '#fff', 4);
    drawCoin(30, H - 16, time, 0.7);
    text('x' + totalCoins, 44, H - 15, 12, GOLD, 4);
    drawMuteButton();
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, W, H);
    const bw = 560, bh = 330, bx = (W - bw) / 2, by = 90;
    ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = RED; ctx.fillRect(bx, by, bw, 8); ctx.fillRect(bx, by + bh - 8, bw, 8);
    ctx.fillRect(bx, by, 8, bh); ctx.fillRect(bx + bw - 8, by, 8, bh);

    ctx.textAlign = 'center';
    text('FIM DE JOGO', W / 2, by + 52, 34, RED_L, 10, 6, RED_D);
    text('PONTOS: ' + score, W / 2, by + 120, 20, '#fff', 0);
    drawCoin(W / 2 - 90, by + 166, time, 1);
    ctx.textAlign = 'left';
    text('MOEDAS: ' + coins, W / 2 - 66, by + 167, 16, GOLD, 0);
    ctx.textAlign = 'center';
    text('RATOS PULADOS: ' + ratsJumped, W / 2, by + 208, 12, PINK, 0);
    if (newRecord) {
      if (Math.floor(time * 4) % 2 === 0) text('NOVO RECORDE!', W / 2, by + 248, 18, PINK, 6);
    } else {
      text('RECORDE: ' + best, W / 2, by + 248, 14, PINK, 0);
    }
    if (overTimer > 0.7 && Math.floor(time * 2) % 2 === 0) {
      text('TOQUE PARA JOGAR DE NOVO', W / 2, by + 296, 14, '#fff', 0);
    }
  }

  function drawLoading() {
    ctx.fillStyle = '#0a0000'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    text('CARREGANDO...', W / 2, H / 2, 20, RED_L, 0);
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    if (state === 'loading') { drawLoading(); return; }
    if (state === 'title') { drawTitle(); drawParticles(); return; }

    ctx.save();
    if (shake > 0) ctx.translate(Math.round(rand(-8, 8)), Math.round(rand(-8, 8)));
    drawBackground();
    drawCeilings();
    drawGround();
    for (const c of coinList) drawCoin(c.x, c.y, c.t);
    drawRats();
    drawCouple(player.x, player.y, time, player.onGround && state === 'play', 1);
    drawParticles();
    ctx.restore();

    drawHUD();
    if (flash > 0) { ctx.fillStyle = `rgba(255,40,60,${flash * 2})`; ctx.fillRect(0, 0, W, H); }
    if (state === 'over') drawGameOver();
  }

  // ---------- Ajuste de tela ----------
  function resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = Math.min((vw - 16) / W, (vh - 16) / H);
    canvas.style.width = Math.floor(W * s) + 'px';
    canvas.style.height = Math.floor(H * s) + 'px';
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  // ---------- Loop ----------
  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05; // evita saltos quando a aba volta
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Início ----------
  const fontReady = (document.fonts && document.fonts.load)
    ? Promise.race([document.fonts.load('20px "Press Start 2P"'), new Promise(r => setTimeout(r, 2500))])
    : Promise.resolve();
  Promise.all([loadImages(), fontReady]).then(() => {
    buildSprites();
    state = 'title';
  });
})();

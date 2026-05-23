import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/* ============================================================
   Mouth Munch! — open your mouth to eat flying emojis.
   ============================================================ */

// ---- DOM ----
const video       = document.getElementById("video");
const canvas      = document.getElementById("canvas");
const ctx         = canvas.getContext("2d");
const hud         = document.getElementById("hud");
const scoreChip   = document.getElementById("scoreChip");
const scoreNum    = document.getElementById("scoreNum");
const timerChip   = document.getElementById("timerChip");
const timerNum    = document.getElementById("timerNum");
const hintEl      = document.getElementById("hint");
const startScreen = document.getElementById("startScreen");
const startBtn    = document.getElementById("startBtn");
const viewScoresBtn = document.getElementById("viewScoresBtn");
const hudPicker   = document.getElementById("hudPicker");
const diffPicker  = document.getElementById("difficultyPicker");
const restartBtn  = document.getElementById("restartBtn");
const endScreen   = document.getElementById("endScreen");
const endScore    = document.getElementById("endScore");
const nameEntry   = document.getElementById("nameEntry");
const nameInput   = document.getElementById("nameInput");
const saveScoreBtn = document.getElementById("saveScoreBtn");
const playAgainBtn = document.getElementById("playAgainBtn");
const backToStartBtn = document.getElementById("backToStartBtn");
const scoreList   = document.getElementById("scoreList");
const scoreListEmpty = document.getElementById("scoreListEmpty");
const scoresOnlyScreen = document.getElementById("scoresOnlyScreen");
const scoreListOnly = document.getElementById("scoreListOnly");
const scoreListOnlyEmpty = document.getElementById("scoreListOnlyEmpty");
const closeScoresBtn = document.getElementById("closeScoresBtn");
const errorScreen = document.getElementById("errorScreen");
const errorMsg    = document.getElementById("errorMsg");
const retryBtn    = document.getElementById("retryBtn");
const loader      = document.getElementById("loader");
const loaderText  = document.getElementById("loaderText");

// ---- Config ----
const EMOJIS = ["💩","🍕","🍩","🍪","🍎","🍌","🍔","🍓","🧁","🍇","⭐","🐸","🍉","🍭"];
const DIFFICULTY = {
  easy:   { label: "🐢 Easy",   speed: 0.65, count: 5 },
  medium: { label: "🐰 Medium", speed: 1.0,  count: 7 },
  fast:   { label: "🚀 Fast",   speed: 1.5,  count: 9 },
};
const ROUND_DURATION = 60;
const JAW_OPEN_THRESHOLD = 0.3;
const SCORES_KEY = "mouthmunch-scoreboard-v1";
const NAME_KEY = "mouthmunch-name";

// ---- State ----
let faceLandmarker = null;
let stream = null;
let running = false;
let celebrating = false;
let recovering = false;
let videoStalledSince = 0;
let lastObservedVideoTime = -1;
let score = 0;
let timeLeft = ROUND_DURATION;
let currentEmoji = "💩";
let difficulty = "medium";

let emojis = [];
let particles = [];
let floaters = [];
let spawnCooldown = 0;
let lastVideoTime = -1;
let lastFrameTime = performance.now();

// Mouth tracking state (in canvas pixel coordinates)
let mouth = { visible: false, open: false, x: 0, y: 0, eatRadius: 0, openAmount: 0 };
let faceMissingTime = 0;

let audioCtx = null;

// ---- Helpers ----
const rand   = (a, b) => a + Math.random() * (b - a);
const randInt = (n) => Math.floor(Math.random() * n);
const clamp  = (v, a, b) => Math.max(a, Math.min(b, v));
const dist   = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* ============================================================
   UI: emoji + difficulty pickers
   ============================================================ */
function buildPickers() {
  EMOJIS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.className = "emoji-btn" + (emoji === currentEmoji ? " selected" : "");
    btn.textContent = emoji;
    btn.addEventListener("click", () => selectEmoji(emoji));
    hudPicker.appendChild(btn);
  });
  Object.entries(DIFFICULTY).forEach(([key, info]) => {
    const btn = document.createElement("button");
    btn.className = "diff-btn" + (key === difficulty ? " selected" : "");
    btn.textContent = info.label;
    btn.dataset.key = key;
    btn.addEventListener("click", () => selectDifficulty(key));
    diffPicker.appendChild(btn);
  });
}

function selectEmoji(emoji) {
  currentEmoji = emoji;
  document.querySelectorAll(".emoji-btn").forEach((b) => {
    b.classList.toggle("selected", b.textContent === emoji);
  });
  // Swap snacks already on screen so the change is instant and obvious.
  emojis.forEach((e) => (e.char = emoji));
}

function selectDifficulty(key) {
  difficulty = key;
  document.querySelectorAll(".diff-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.key === key);
  });
}

/* ============================================================
   Audio — a happy "da-ding!" on every munch.
   ============================================================ */
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function tone(freq, start, dur, gainPeak, type = "triangle") {
  const t = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(gainPeak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function playDing() {
  if (!audioCtx) return;
  tone(880, 0, 0.13, 0.35);          // da
  tone(1318.5, 0.085, 0.28, 0.35);   // ding (rising)
  tone(2637, 0.085, 0.3, 0.12, "sine"); // sparkle on top
}

function playWin() {
  if (!audioCtx) return;
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  notes.forEach((f, i) => tone(f, i * 0.12, 0.35, 0.32));
  tone(1568, 0.6, 0.6, 0.2, "sine");
}

/* ============================================================
   Camera + face model setup
   ============================================================ */
async function loadFaceModel() {
  if (faceLandmarker) return;
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  const options = {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch (e) {
    // Some devices lack GPU support — fall back to CPU.
    options.baseOptions.delegate = "CPU";
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
  }
}

async function startCamera() {
  // Clean up any previous stream so iOS Safari doesn't hand back a stale black feed.
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video.srcObject) {
    video.srcObject = null;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((res) => (video.onloadedmetadata = res));
  }
  videoStalledSince = 0;
  lastObservedVideoTime = -1;
}

async function recoverCamera() {
  if (recovering) return;
  recovering = true;
  hintEl.textContent = "📷 Reconnecting camera…";
  try {
    await startCamera();
  } catch (err) {
    recovering = false;
    running = false;
    showError("Camera disconnected. Tap retry to reconnect.");
    return;
  }
  recovering = false;
  lastFrameTime = performance.now();
}

/* ============================================================
   Start / restart flow
   ============================================================ */
async function start() {
  startBtn.disabled = true;
  loader.classList.remove("hidden");
  ensureAudio();
  try {
    loaderText.textContent = "Turning on the camera…";
    await startCamera();
    loaderText.textContent = "Waking up the face tracker…";
    await loadFaceModel();
  } catch (err) {
    loader.classList.add("hidden");
    startBtn.disabled = false;
    showError(describeError(err));
    return;
  }
  loader.classList.add("hidden");
  startScreen.classList.add("hidden");
  hud.classList.remove("hidden");

  resetGame();
  running = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(loop);
}

function describeError(err) {
  const name = err && err.name ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "I need permission to use the camera. Please allow camera access and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "I couldn't find a camera on this device.";
  }
  if (name === "NotReadableError") {
    return "The camera is busy. Close other apps using it and try again.";
  }
  return "Couldn't start the game. Check your internet connection and camera, then try again.";
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorScreen.classList.remove("hidden");
}

function resetGame() {
  score = 0;
  timeLeft = ROUND_DURATION;
  celebrating = false;
  emojis = [];
  particles = [];
  floaters = [];
  spawnCooldown = 0;
  // Pre-fill the board so there's something to eat right away.
  const target = DIFFICULTY[difficulty].count;
  for (let i = 0; i < Math.ceil(target / 2); i++) spawnEmoji();
  updateScoreUI(false);
  updateTimerUI();
}

/* ============================================================
   Canvas sizing
   ============================================================ */
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// Where the camera image lands on the canvas (object-fit: cover).
function videoRect() {
  const cw = canvas.width, ch = canvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { dx: 0, dy: 0, dw: cw, dh: ch };
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

/* ============================================================
   Emojis
   ============================================================ */
function spawnEmoji() {
  const unit = Math.min(canvas.width, canvas.height) || 800;
  const size = clamp(unit * 0.088, 40, 100) * rand(0.85, 1.15);
  const r = size * 0.42;
  const speed = rand(110, 240) * (unit / 800) * DIFFICULTY[difficulty].speed;

  // Spawn just off a random edge, aimed roughly toward the screen.
  const edge = randInt(4);
  let x, y, angle;
  if (edge === 0)      { x = rand(0, canvas.width); y = -r;                  angle = rand(0.25, 0.75) * Math.PI; }
  else if (edge === 1) { x = rand(0, canvas.width); y = canvas.height + r;   angle = rand(1.25, 1.75) * Math.PI; }
  else if (edge === 2) { x = -r;                    y = rand(0, canvas.height); angle = rand(-0.25, 0.25) * Math.PI; }
  else                 { x = canvas.width + r;      y = rand(0, canvas.height); angle = rand(0.75, 1.25) * Math.PI; }

  emojis.push({
    char: currentEmoji,
    x, y, size, r,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    rot: rand(0, Math.PI * 2),
    rotSpeed: rand(-1.8, 1.8),
    wobble: rand(0, Math.PI * 2),
    entered: false,
  });
}

function maybeSpawn(dt) {
  spawnCooldown -= dt;
  const target = DIFFICULTY[difficulty].count;
  if (emojis.length < target && spawnCooldown <= 0) {
    spawnEmoji();
    spawnCooldown = rand(0.3, 0.9);
  }
}

function updateEmojis(dt) {
  const w = canvas.width, h = canvas.height;
  for (let i = emojis.length - 1; i >= 0; i--) {
    const e = emojis[i];
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.rot += e.rotSpeed * dt;
    e.wobble += dt * 4;

    // Once fully on screen, bounce off the walls.
    if (!e.entered &&
        e.x > e.r && e.x < w - e.r &&
        e.y > e.r && e.y < h - e.r) {
      e.entered = true;
    }
    if (e.entered) {
      if (e.x < e.r)        { e.x = e.r;        e.vx = Math.abs(e.vx); }
      if (e.x > w - e.r)    { e.x = w - e.r;    e.vx = -Math.abs(e.vx); }
      if (e.y < e.r)        { e.y = e.r;        e.vy = Math.abs(e.vy); }
      if (e.y > h - e.r)    { e.y = h - e.r;    e.vy = -Math.abs(e.vy); }
    } else if (e.x < -200 || e.x > w + 200 || e.y < -200 || e.y > h + 200) {
      // Wandered off without ever entering — drop it.
      emojis.splice(i, 1);
    }
  }
}

function handleEating() {
  if (!mouth.visible || !mouth.open) return;
  for (let i = emojis.length - 1; i >= 0; i--) {
    const e = emojis[i];
    if (dist(mouth.x, mouth.y, e.x, e.y) < mouth.eatRadius + e.r * 0.6) {
      emojis.splice(i, 1);
      eat(e);
    }
  }
}

function eat(e) {
  score++;
  spawnBurst(e.x, e.y);
  floaters.push({
    x: e.x, y: e.y, vy: -120,
    life: 0, maxLife: 0.9,
    text: "+1", size: e.size * 0.9, color: "#ffd34d",
  });
  playDing();
  updateScoreUI(true);
}

/* ============================================================
   Particle effects
   ============================================================ */
function spawnBurst(x, y) {
  const unit = Math.min(canvas.width, canvas.height) || 800;
  const base = unit * 0.06;
  // Expanding ring.
  particles.push({ kind: "ring", x, y, life: 0, maxLife: 0.5, r0: base * 0.4, r1: base * 3 });
  // Big star that pops.
  particles.push({
    kind: "pop", x, y, life: 0, maxLife: 0.7,
    r: base * 1.7, rot: rand(-0.4, 0.4), rotSpeed: rand(-3, 3),
  });
  // Star sparks flying outward.
  const sparks = 12;
  for (let i = 0; i < sparks; i++) {
    const ang = (i / sparks) * Math.PI * 2 + rand(-0.3, 0.3);
    const sp = rand(180, 420) * (unit / 800);
    particles.push({
      kind: "star", x, y,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: 0, maxLife: rand(0.5, 0.85),
      r: base * rand(0.3, 0.6), rot: rand(0, 6.28), rotSpeed: rand(-8, 8),
      color: ["#ffd34d", "#ff8a00", "#ff5ea8", "#fff"][randInt(4)],
    });
  }
}

function spawnConfetti() {
  const unit = Math.min(canvas.width, canvas.height) || 800;
  const colors = ["#ffd34d", "#ff8a00", "#ff5ea8", "#7b2ff7", "#3ad6c5", "#fff"];
  for (let i = 0; i < 90; i++) {
    particles.push({
      kind: "confetti",
      x: rand(0, canvas.width),
      y: rand(-canvas.height * 0.4, 0),
      vx: rand(-60, 60),
      vy: rand(120, 320),
      life: 0, maxLife: rand(2.5, 4),
      w: unit * rand(0.012, 0.026),
      h: unit * rand(0.02, 0.04),
      rot: rand(0, 6.28), rotSpeed: rand(-6, 6),
      color: colors[randInt(colors.length)],
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
    if (p.kind === "star") {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 600 * dt;
      p.rot += p.rotSpeed * dt;
    } else if (p.kind === "confetti") {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.rotSpeed * dt;
      if (p.y > canvas.height + 60) { particles.splice(i, 1); }
    } else if (p.kind === "pop") {
      p.rot += p.rotSpeed * dt;
    }
  }
}

function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    f.y += f.vy * dt;
    if (f.life >= f.maxLife) floaters.splice(i, 1);
  }
}

/* ============================================================
   Video stall watchdog — catches iOS's silent black-frame bug
   when the stream stops producing frames after backgrounding.
   ============================================================ */
function checkVideoHealth(dt) {
  if (!running || recovering) return;
  if (!stream) return;
  // Dead track? Recover immediately.
  const tracks = stream.getVideoTracks();
  if (tracks.length === 0 || tracks.some((t) => t.readyState === "ended")) {
    recoverCamera();
    return;
  }
  if (!video.videoWidth) return;
  if (video.currentTime !== lastObservedVideoTime) {
    lastObservedVideoTime = video.currentTime;
    videoStalledSince = 0;
  } else {
    videoStalledSince += dt;
    if (videoStalledSince > 2.5) {
      recoverCamera();
    }
  }
}

/* ============================================================
   Face detection
   ============================================================ */
function detectFace() {
  if (!faceLandmarker || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  let result;
  try {
    result = faceLandmarker.detectForVideo(video, performance.now());
  } catch {
    return;
  }

  if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
    mouth.visible = false;
    mouth.open = false;
    return;
  }

  const lm = result.faceLandmarks[0];
  const rect = videoRect();
  // Landmarks are normalized to the video; map to canvas, mirrored to match the display.
  const toCanvas = (p) => ({
    x: canvas.width - (rect.dx + p.x * rect.dw),
    y: rect.dy + p.y * rect.dh,
  });

  const upper = toCanvas(lm[13]);   // inner upper lip
  const lower = toCanvas(lm[14]);   // inner lower lip
  const left  = toCanvas(lm[61]);   // mouth corner
  const right = toCanvas(lm[291]);  // mouth corner

  const mouthWidth = dist(left.x, left.y, right.x, right.y);
  const lipGap = dist(upper.x, upper.y, lower.x, lower.y);
  const gapRatio = lipGap / (mouthWidth || 1);

  // Prefer the jawOpen blendshape; fall back to the lip-gap ratio.
  let jaw = 0;
  if (result.faceBlendshapes && result.faceBlendshapes.length) {
    const cat = result.faceBlendshapes[0].categories.find(
      (c) => c.categoryName === "jawOpen"
    );
    if (cat) jaw = cat.score;
  }

  const unit = Math.min(canvas.width, canvas.height) || 800;
  mouth.visible = true;
  mouth.x = (upper.x + lower.x) / 2;
  mouth.y = (upper.y + lower.y) / 2;
  mouth.open = jaw > JAW_OPEN_THRESHOLD || gapRatio > 0.32;
  mouth.openAmount = clamp(Math.max(jaw, gapRatio), 0, 1);
  // A generous, kid-friendly eat zone that grows as the mouth opens wider.
  mouth.eatRadius = mouthWidth * 0.8 + unit * 0.03 + mouth.openAmount * unit * 0.05;
}

/* ============================================================
   Rendering
   ============================================================ */
function drawStar(x, y, r, rot, color, points = 5) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const ang = (Math.PI / points) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawVideo() {
  const r = videoRect();
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}

function drawEatZone() {
  if (!mouth.visible) return;
  const t = performance.now() / 1000;
  if (mouth.open) {
    const pulse = 1 + Math.sin(t * 12) * 0.06;
    const r = mouth.eatRadius * pulse;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const grad = ctx.createRadialGradient(mouth.x, mouth.y, r * 0.2, mouth.x, mouth.y, r);
    grad.addColorStop(0, "rgba(255, 211, 77, 0.55)");
    grad.addColorStop(1, "rgba(255, 211, 77, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = Math.max(3, mouth.eatRadius * 0.06);
    ctx.strokeStyle = "rgba(255, 211, 77, 0.95)";
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.lineWidth = Math.max(2, mouth.eatRadius * 0.03);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.setLineDash([12, 10]);
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, mouth.eatRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawEmojis() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const e of emojis) {
    const wob = 1 + Math.sin(e.wobble) * 0.06;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.rot);
    ctx.font = `${e.size * wob}px serif`;
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = e.size * 0.15;
    ctx.fillText(e.char, 0, 0);
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of particles) {
    const t = p.life / p.maxLife;
    if (p.kind === "ring") {
      const r = p.r0 + (p.r1 - p.r0) * t;
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = Math.max(2, p.r1 * 0.12 * (1 - t));
      ctx.strokeStyle = "#ffd34d";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (p.kind === "pop") {
      const grow = t < 0.4 ? t / 0.4 : 1;
      const ease = 1 - Math.pow(1 - grow, 3);
      ctx.globalAlpha = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      drawStar(p.x, p.y, p.r * ease * 1.15, p.rot, "#fff");
      drawStar(p.x, p.y, p.r * ease, p.rot, "#ffd34d");
      ctx.globalAlpha = 1;
    } else if (p.kind === "star") {
      ctx.globalAlpha = 1 - t;
      drawStar(p.x, p.y, p.r, p.rot, p.color);
      ctx.globalAlpha = 1;
    } else if (p.kind === "confetti") {
      ctx.globalAlpha = clamp(1 - (t - 0.7) / 0.3, 0, 1);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
}

function drawFloaters() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const f of floaters) {
    const t = f.life / f.maxLife;
    ctx.globalAlpha = 1 - t;
    ctx.font = `800 ${f.size}px "Baloo 2", system-ui, sans-serif`;
    ctx.lineWidth = f.size * 0.12;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.fillStyle = f.color;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (video.videoWidth) drawVideo();
  else { ctx.fillStyle = "#1b0b3a"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  drawEatZone();
  drawEmojis();
  drawParticles();
  drawFloaters();
}

/* ============================================================
   HUD
   ============================================================ */
function updateScoreUI(pop) {
  scoreNum.textContent = score;
  if (pop) {
    scoreChip.classList.remove("pop");
    void scoreChip.offsetWidth; // restart the animation
    scoreChip.classList.add("pop");
  }
}

function updateTimerUI() {
  timerNum.textContent = Math.ceil(timeLeft);
  timerChip.classList.toggle("urgent", timeLeft <= 10 && !celebrating);
}

function updateHint() {
  if (!mouth.visible) {
    if (faceMissingTime > 0.6) hintEl.textContent = "👀 I can't see you — move into the frame!";
    return;
  }
  hintEl.textContent = mouth.open ? "😋 Yum! Keep munching!" : "😮 Open wide to munch!";
}

/* ============================================================
   Timer + end of round
   ============================================================ */
function tickTimer(dt) {
  if (celebrating) return;
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    endRound();
  }
  updateTimerUI();
}

function endRound() {
  celebrating = true;
  endScore.textContent = score;
  nameEntry.classList.remove("hidden");
  saveScoreBtn.disabled = false;
  nameInput.value = loadName();
  renderScoreboard(scoreList, scoreListEmpty, null);
  endScreen.classList.remove("hidden");
  spawnConfetti();
  playWin();
}

/* ============================================================
   Scoreboard storage
   ============================================================ */
function loadScores() {
  try { return JSON.parse(localStorage.getItem(SCORES_KEY)) || []; }
  catch { return []; }
}

function saveScores(scores) {
  try { localStorage.setItem(SCORES_KEY, JSON.stringify(scores)); } catch {}
}

function addScore(name, score, difficulty) {
  const scores = loadScores();
  const entry = {
    name: (name || "Anonymous").trim().slice(0, 12) || "Anonymous",
    score,
    difficulty,
    date: Date.now(),
  };
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score || a.date - b.date);
  if (scores.length > 25) scores.length = 25;
  saveScores(scores);
  return entry;
}

function loadName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch {}
}

function renderScoreboard(listEl, emptyEl, highlightEntry) {
  const scores = loadScores().slice(0, 10);
  listEl.innerHTML = "";
  if (scores.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  scores.forEach((entry, i) => {
    const li = document.createElement("li");
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
    li.innerHTML = `
      <span class="rank">${medal}</span>
      <span class="name"></span>
      <span class="score">⭐ ${entry.score}</span>
    `;
    li.querySelector(".name").textContent = entry.name;
    if (highlightEntry &&
        entry.name === highlightEntry.name &&
        entry.score === highlightEntry.score &&
        entry.date === highlightEntry.date) {
      li.classList.add("new");
    }
    listEl.appendChild(li);
  });
}

saveScoreBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  rememberName(name);
  const entry = addScore(name, score, difficulty);
  nameEntry.classList.add("hidden");
  renderScoreboard(scoreList, scoreListEmpty, entry);
});

playAgainBtn.addEventListener("click", () => {
  endScreen.classList.add("hidden");
  resetGame();
});

backToStartBtn.addEventListener("click", () => {
  endScreen.classList.add("hidden");
  hud.classList.add("hidden");
  startScreen.classList.remove("hidden");
  stopGame();
});

viewScoresBtn.addEventListener("click", () => {
  renderScoreboard(scoreListOnly, scoreListOnlyEmpty, null);
  scoresOnlyScreen.classList.remove("hidden");
});

closeScoresBtn.addEventListener("click", () => {
  scoresOnlyScreen.classList.add("hidden");
});

restartBtn.addEventListener("click", () => {
  endScreen.classList.add("hidden");
  resetGame();
});

function stopGame() {
  running = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  startBtn.disabled = false;
}

/* ============================================================
   Main loop
   ============================================================ */
function loop() {
  if (!running) return;

  const now = performance.now();
  let dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  dt = Math.min(dt, 0.05); // guard against tab-switch jumps

  resizeCanvas();
  detectFace();
  checkVideoHealth(dt);

  faceMissingTime = mouth.visible ? 0 : faceMissingTime + dt;

  updateEmojis(dt);
  updateParticles(dt);
  updateFloaters(dt);
  if (!celebrating) {
    maybeSpawn(dt);
    handleEating();
    tickTimer(dt);
  }

  render();
  updateHint();

  requestAnimationFrame(loop);
}

/* ============================================================
   Wire up
   ============================================================ */
buildPickers();
startBtn.addEventListener("click", start);
retryBtn.addEventListener("click", () => {
  errorScreen.classList.add("hidden");
  start();
});

// Keep the camera frames flowing when returning to the tab.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && running) {
    lastFrameTime = performance.now();
    videoStalledSince = 0;
    lastObservedVideoTime = -1;
    if (video.paused) video.play().catch(() => {});
    if (stream && stream.getVideoTracks().some((t) => t.readyState === "ended")) {
      recoverCamera();
    }
  }
});

/* ============================================================
   PWA: service worker + install prompt
   ============================================================ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

const installBtn = document.getElementById("installBtn");
const iosInstallHint = document.getElementById("iosInstallHint");
let deferredInstallPrompt = null;

const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches ||
  window.matchMedia("(display-mode: fullscreen)").matches ||
  window.navigator.standalone === true;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

if (!isStandalone && isIOS) {
  iosInstallHint.classList.remove("hidden");
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone) installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.disabled = true;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => {});
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
  iosInstallHint.classList.add("hidden");
  deferredInstallPrompt = null;
});

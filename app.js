/*
 * AR Volleyball - Under Pass Challenge (Ball Response Fix)
 * Frontend: GitHub Pages HTTPS
 * AI: MediaPipe Tasks Vision / Pose Landmarker
 * Backend: Google Apps Script JSONP
 */

const CONFIG = Object.freeze({
  API_URL: "PASTE_YOUR_APPS_SCRIPT_WEB_APP_EXEC_URL_HERE",
  GAME_SECONDS: 180,
  CALIBRATION_MS: 1400,
  MODEL_TIMEOUT_MS: 30000,
  API_TIMEOUT_MS: 12000,
  MIN_ELBOW_ANGLE: 112,
  GOOD_ELBOW_ANGLE: 132,
  MAX_WRIST_TO_SHOULDER_RATIO: 0.90,
  GOOD_WRIST_TO_SHOULDER_RATIO: 0.66,
  MIN_LANDMARK_VISIBILITY: 0.42,
  COLLISION_EXTRA_RADIUS: 62,
  SHOW_SKELETON: true,
  SHOW_HIT_ZONE: true
});

const MODEL_CANDIDATES = [
  {
    bundle: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  },
  {
    bundle: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    wasm: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm"
  }
];

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (id) => document.getElementById(id);

const ui = {
  home: $("homeScreen"),
  game: $("gameScreen"),
  result: $("resultScreen"),
  video: $("webcam"),
  canvas: $("overlay"),
  score: $("score"),
  timer: $("timer"),
  phase: $("phaseLabel"),
  combo: $("combo"),
  soundToggle: $("soundToggle"),
  missionCount: $("missionCount"),
  missionProgress: $("missionProgress"),
  statusTitle: $("statusTitle"),
  statusText: $("statusText"),
  progress: $("calibrationProgress"),
  tip: $("tipBubble"),
  feedback: $("feedback"),
  playerName: $("playerName"),
  errorModal: $("errorModal"),
  leaderboardModal: $("leaderboardModal")
};

const ctx = ui.canvas.getContext("2d", { alpha: true });

let cameraStream = null;
let poseLandmarker = null;
let wasmBasePath = null;
let modelLoadPromise = null;
let gameLoopId = null;
let running = false;
let finishing = false;
let phase = "home";

let score = 0;
let combo = 0;
let gameStartedAt = 0;
let previousAnimationAt = 0;
let previousVideoTime = -1;
let previousDetectionAt = 0;
let calibrationMs = 0;
let currentPose = null;
let currentUnder = { contactReady: false, good: false, reason: "มองกล้องให้เห็นแขนทั้งสองข้าง" };
let ball = null;
let canvasCssWidth = 0;
let canvasCssHeight = 0;
let canvasDpr = 1;
let soundEnabled = true;
let audioContext = null;

bindEvents();
renderInitialTimer();

function bindEvents() {
  $("startBtn").addEventListener("click", startGame);
  $("exitBtn").addEventListener("click", () => finishGame(false));
  $("playAgainBtn").addEventListener("click", returnHome);
  $("leaderboardBtn").addEventListener("click", showLeaderboard);
  $("resultLeaderboardBtn").addEventListener("click", showLeaderboard);
  $("closeLeaderboard").addEventListener("click", () => ui.leaderboardModal.classList.add("hidden"));
  $("closeError").addEventListener("click", () => ui.errorModal.classList.add("hidden"));
  ui.soundToggle.addEventListener("click", toggleSound);

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", () => window.setTimeout(resizeCanvas, 250));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running) finishGame(false);
  });
}

function showScreen(target) {
  [ui.home, ui.game, ui.result].forEach(screen => screen.classList.add("hidden"));
  target.classList.remove("hidden");
}

function setStatus(title, text) {
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
}

function showError(title, message) {
  $("errorTitle").textContent = title;
  $("errorText").textContent = message;
  ui.errorModal.classList.remove("hidden");
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderInitialTimer() {
  ui.timer.textContent = formatTime(CONFIG.GAME_SECONDS);
}

async function startGame() {
  if (running || phase === "calibrating" || phase === "playing") return;

  const name = ui.playerName.value.trim();
  if (!name) {
    showError("กรุณากรอกชื่อผู้เล่น", "กรอกชื่อหรือรหัสผู้เล่นก่อนเริ่มเกม");
    return;
  }

  $("startBtn").disabled = true;
  initAudio();
  ui.errorModal.classList.add("hidden");
  showScreen(ui.game);
  phase = "calibrating";
  resetGameState();
  resizeCanvas();
  setStatus("กำลังขอใช้กล้อง 📷", "โปรดกด Allow เมื่อ Safari ถามสิทธิ์การใช้งานกล้อง");

  try {
    await startCamera();
    setStatus("กล้องพร้อมแล้ว", "กำลังโหลดระบบ AI ตรวจจับท่าทาง...");
    await loadPoseModel();

    running = true;
    previousAnimationAt = performance.now();
    previousVideoTime = -1;
    previousDetectionAt = 0;
    setStatus("เตรียมท่าอันเดอร์ 🤝", "ประสานมือ เหยียดแขน และค้างท่าเพื่อปรับเทียบ");
    ui.tip.textContent = "💡 ให้กล้องเห็นไหล่ ข้อศอก และข้อมือทั้งสองข้าง";
    gameLoopId = requestAnimationFrame(gameLoop);
  } catch (error) {
    console.error("[AR Volleyball] Start failed:", error);
    stopCamera();
    running = false;
    phase = "home";
    showScreen(ui.home);
    $("startBtn").disabled = false;
    showError(getFriendlyErrorTitle(error), getFriendlyErrorMessage(error));
  }
}

function resetGameState() {
  score = 0;
  combo = 0;
  calibrationMs = 0;
  gameStartedAt = 0;
  currentPose = null;
  currentUnder = { contactReady: false, good: false, reason: "มองกล้องให้เห็นแขนทั้งสองข้าง" };
  ball = null;
  ui.score.textContent = "0";
  ui.combo.textContent = "x0";
  ui.soundToggle.textContent = soundEnabled ? "🔊 เสียงเปิด" : "🔇 เสียงปิด";
  ui.missionCount.textContent = "0 / 15";
  ui.missionProgress.style.width = "0%";
  ui.timer.textContent = formatTime(CONFIG.GAME_SECONDS);
  ui.phase.textContent = "CALIBRATION";
  ui.progress.style.width = "0%";
  ui.feedback.classList.add("hidden");
}

/* CAMERA */
async function startCamera() {
  if (!window.isSecureContext) throw new Error("INSECURE_CONTEXT");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("CAMERA_API_UNAVAILABLE");

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 960 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    }
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (error.name === "OverconstrainedError") {
      cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
    } else {
      throw error;
    }
  }

  ui.video.srcObject = cameraStream;
  ui.video.setAttribute("playsinline", "");
  ui.video.muted = true;

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("CAMERA_START_TIMEOUT")), 12000);
    ui.video.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
    ui.video.onerror = () => { clearTimeout(timeout); reject(new Error("VIDEO_ELEMENT_ERROR")); };
  });

  await ui.video.play();
  resizeCanvas();
}

/* MEDIAPIPE */
async function loadPoseModel() {
  if (poseLandmarker) return;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    let module = null;
    let lastError = null;

    for (const candidate of MODEL_CANDIDATES) {
      try {
        module = await withTimeout(
          import(candidate.bundle),
          CONFIG.MODEL_TIMEOUT_MS,
          "หมดเวลารอโหลด MediaPipe JavaScript"
        );
        wasmBasePath = candidate.wasm;
        break;
      } catch (error) {
        console.warn("MediaPipe CDN failed:", candidate.bundle, error);
        lastError = error;
      }
    }

    if (!module) {
      throw new Error("โหลด MediaPipe ไม่สำเร็จจาก CDN ทั้งสองแหล่ง: " + (lastError?.message || ""));
    }

    const { FilesetResolver, PoseLandmarker } = module;
    if (!FilesetResolver || !PoseLandmarker) {
      throw new Error("MediaPipe module ไม่มี FilesetResolver หรือ PoseLandmarker");
    }

    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(wasmBasePath),
      CONFIG.MODEL_TIMEOUT_MS,
      "หมดเวลารอโหลด MediaPipe WASM"
    );

    poseLandmarker = await withTimeout(
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.50,
        minPosePresenceConfidence: 0.50,
        minTrackingConfidence: 0.50
      }),
      CONFIG.MODEL_TIMEOUT_MS,
      "หมดเวลารอโหลดโมเดลตรวจจับร่างกาย"
    );
  })();

  try {
    await modelLoadPromise;
  } catch (error) {
    modelLoadPromise = null;
    throw error;
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), ms))
  ]);
}

/* CANVAS / CAMERA COORDINATES */
function resizeCanvas() {
  const rect = ui.game.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  canvasCssWidth = rect.width;
  canvasCssHeight = rect.height;
  canvasDpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.width = Math.round(canvasCssWidth * canvasDpr);
  ui.canvas.height = Math.round(canvasCssHeight * canvasDpr);
  ui.canvas.style.width = `${canvasCssWidth}px`;
  ui.canvas.style.height = `${canvasCssHeight}px`;
  ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
}

function mapPoint(landmark) {
  const sourceWidth = ui.video.videoWidth || canvasCssWidth;
  const sourceHeight = ui.video.videoHeight || canvasCssHeight;
  const scale = Math.max(canvasCssWidth / sourceWidth, canvasCssHeight / sourceHeight);
  const shownWidth = sourceWidth * scale;
  const shownHeight = sourceHeight * scale;
  const offsetX = (canvasCssWidth - shownWidth) / 2;
  const offsetY = (canvasCssHeight - shownHeight) / 2;

  return {
    x: (1 - landmark.x) * shownWidth + offsetX,
    y: landmark.y * shownHeight + offsetY
  };
}

/* MAIN LOOP */
function gameLoop(timestamp) {
  if (!running) return;

  const dt = Math.min(Math.max((timestamp - previousAnimationAt) / 1000, 0), 0.05);
  previousAnimationAt = timestamp;

  if (ui.video.readyState >= 2 && ui.video.currentTime !== previousVideoTime) {
    previousVideoTime = ui.video.currentTime;

    try {
      const result = poseLandmarker.detectForVideo(ui.video, timestamp);
      currentPose = result.landmarks?.[0] || null;
      currentUnder = currentPose
        ? evaluateUnderPass(currentPose)
        : { contactReady: false, good: false, reason: "ไม่พบร่างกาย กรุณาถอยให้เห็นช่วงบนและแขน" };
      handleCalibration(timestamp);
    } catch (error) {
      console.error("Pose detection error:", error);
      setStatus("AI ตรวจจับสะดุด", "ลองจัดแสงหรือขยับให้อยู่ในภาพกล้อง");
    }
  }

  if (phase === "playing") {
    const remaining = Math.max(0, CONFIG.GAME_SECONDS - (timestamp - gameStartedAt) / 1000);
    ui.timer.textContent = formatTime(remaining);
    if (remaining <= 0) {
      finishGame(true);
      return;
    }
    updateBall(dt);
  }

  renderFrame();
  gameLoopId = requestAnimationFrame(gameLoop);
}

/* POSTURE EVALUATION
   contactReady = relaxed movement gate used for game contact.
   good = stricter form quality indicator for feedback only.
*/
function evaluateUnderPass(pose) {
  const ls = pose[11], rs = pose[12], le = pose[13], re = pose[14], lw = pose[15], rw = pose[16];
  const required = [ls, rs, le, re, lw, rw];

  if (required.some(point => !point)) {
    return { contactReady: false, good: false, reason: "ให้เห็นไหล่ ข้อศอก และข้อมือทั้งสองข้าง" };
  }

  const visible = required.every(point => {
    const confidence = point.visibility ?? point.presence ?? 1;
    return confidence >= CONFIG.MIN_LANDMARK_VISIBILITY;
  });

  if (!visible) {
    return { contactReady: false, good: false, reason: "แขนถูกบังหรืออยู่นอกภาพ กรุณาจัดตำแหน่งใหม่" };
  }

  const shoulderWidth = distance(ls, rs);
  if (shoulderWidth < 0.045) {
    return { contactReady: false, good: false, reason: "กรุณาถอยให้เห็นช่วงไหล่ชัดเจน" };
  }

  const leftAngle = calculateAngle(ls, le, lw);
  const rightAngle = calculateAngle(rs, re, rw);
  const wristRatio = distance(lw, rw) / shoulderWidth;
  const shoulderY = (ls.y + rs.y) / 2;
  const wristY = (lw.y + rw.y) / 2;
  const wristsLevelRatio = Math.abs(lw.y - rw.y);

  const elbowsAcceptable =
    leftAngle >= CONFIG.MIN_ELBOW_ANGLE && rightAngle >= CONFIG.MIN_ELBOW_ANGLE;
  const handsNear =
    wristRatio <= CONFIG.MAX_WRIST_TO_SHOULDER_RATIO;
  const handsForward =
    wristY > shoulderY - 0.10;
  const wristsLevel =
    wristsLevelRatio < 0.25;

  const leftElbowPx = mapPoint(le);
  const rightElbowPx = mapPoint(re);
  const leftWristPx = mapPoint(lw);
  const rightWristPx = mapPoint(rw);

  // The two forearm midpoints form a broad, approximate receiving platform.
  const leftForearmMid = midpoint(leftElbowPx, leftWristPx);
  const rightForearmMid = midpoint(rightElbowPx, rightWristPx);
  const platform = {
    a: leftForearmMid,
    b: rightForearmMid,
    center: midpoint(leftForearmMid, rightForearmMid),
    forearms: [
      { a: leftElbowPx, b: leftWristPx },
      { a: rightElbowPx, b: rightWristPx }
    ]
  };

  const contactReady = elbowsAcceptable && handsNear && handsForward && wristsLevel;
  const good =
    leftAngle >= CONFIG.GOOD_ELBOW_ANGLE &&
    rightAngle >= CONFIG.GOOD_ELBOW_ANGLE &&
    wristRatio <= CONFIG.GOOD_WRIST_TO_SHOULDER_RATIO &&
    handsForward &&
    wristsLevel;

  let reason = "ท่าอันเดอร์พร้อมแล้ว";
  if (!handsNear) reason = "ประสานมือทั้งสองข้างให้ใกล้กัน";
  else if (!elbowsAcceptable) reason = "เหยียดแขนให้ตรงขึ้น";
  else if (!handsForward) reason = "ยื่นแขนไว้ด้านหน้าลำตัว";
  else if (!wristsLevel) reason = "จัดแนวข้อมือทั้งสองข้างให้ใกล้ระดับเดียวกัน";
  else if (!good) reason = "รับลูกได้แล้ว ลองเหยียดแขนให้ตรงขึ้นอีกนิด";

  return {
    contactReady, good, reason, platform,
    leftAngle, rightAngle, wristRatio
  };
}

function handleCalibration(timestamp) {
  if (phase !== "calibrating") return;

  const frameDelta = previousDetectionAt
    ? Math.min(timestamp - previousDetectionAt, 100)
    : 0;
  previousDetectionAt = timestamp;

  if (currentUnder.contactReady) {
    calibrationMs += frameDelta;
  } else {
    calibrationMs = Math.max(0, calibrationMs - frameDelta * 1.5);
  }

  const progress = Math.min(100, Math.round((calibrationMs / CONFIG.CALIBRATION_MS) * 100));
  ui.progress.style.width = `${progress}%`;
  setStatus(
    currentUnder.contactReady ? "ท่าพร้อมแล้ว! กำลังปรับเทียบ 🤝" : "เตรียมท่าอันเดอร์",
    currentUnder.reason
  );

  if (calibrationMs >= CONFIG.CALIBRATION_MS) {
    phase = "playing";
    ui.phase.textContent = "MATCH ON";
    ui.tip.textContent = "🏐 ลูกบอลจะตกลงมา รับด้วยแนวท่อนแขนทั้งสองข้าง";
    setStatus("เริ่มการแข่งขันแล้ว!", "รักษาแนวท่อนแขนให้พร้อมรับลูก");
    gameStartedAt = timestamp;
    previousAnimationAt = timestamp;
    spawnBall();
  }
}

/* RENDER */
function renderFrame() {
  ctx.clearRect(0, 0, canvasCssWidth, canvasCssHeight);
  if (currentPose && CONFIG.SHOW_SKELETON) drawSkeleton(currentPose);
  if (ball) drawVolleyball(ball.x, ball.y, ball.radius);
}

function drawSkeleton(pose) {
  const pairs = [[11,13],[13,15],[12,14],[14,16],[11,12]];
  const contactReady = currentUnder.contactReady;

  ctx.save();
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = contactReady ? "rgba(45,255,161,.95)" : "rgba(120,195,255,.82)";

  pairs.forEach(([a,b]) => {
    const p1 = mapPoint(pose[a]);
    const p2 = mapPoint(pose[b]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  });

  [11,12,13,14,15,16].forEach(index => {
    const point = mapPoint(pose[index]);
    ctx.beginPath();
    ctx.fillStyle = contactReady ? "#4dffb0" : "#ffdf65";
    ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  if (CONFIG.SHOW_HIT_ZONE && currentUnder.platform) {
    const { a, b } = currentUnder.platform;
    ctx.strokeStyle = contactReady ? "rgba(45,255,161,.85)" : "rgba(255,221,100,.58)";
    ctx.lineWidth = 18;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Draw broad forearm guides to show the actual collision region.
    currentUnder.platform.forearms.forEach(segment => {
      ctx.strokeStyle = "rgba(255,255,255,.48)";
      ctx.lineWidth = 22;
      ctx.beginPath();
      ctx.moveTo(segment.a.x, segment.a.y);
      ctx.lineTo(segment.b.x, segment.b.y);
      ctx.stroke();
    });
  }
  ctx.restore();
}

/* BALL PHYSICS AND COLLISION */
function spawnBall() {
  const width = canvasCssWidth;
  const radius = Math.max(25, Math.min(width, canvasCssHeight) * 0.055);
  const platformCenter = currentUnder.platform?.center;
  const targetX = platformCenter ? platformCenter.x : width * 0.5;
  // Start nearly above the player's receiving platform. Variation grows gently with score.
  const spread = Math.min(width * 0.055, score * 1.2);
  const variation = (Math.random() - 0.5) * spread * 2;

  ball = {
    x: clamp(targetX + variation, radius + 10, width - radius - 10),
    y: -radius - 8,
    vx: (Math.random() - 0.5) * 10,
    vy: 115 + Math.min(score * 2, 60),
    radius,
    scored: false
  };
}

function updateBall(dt) {
  if (!ball) return;

  const gravity = 500;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vy += gravity * dt;

  // Keep the ball inside the visible play area.
  if (ball.x < ball.radius) {
    ball.x = ball.radius;
    ball.vx = Math.abs(ball.vx) * 0.65;
  } else if (ball.x > canvasCssWidth - ball.radius) {
    ball.x = canvasCssWidth - ball.radius;
    ball.vx = -Math.abs(ball.vx) * 0.65;
  }

  if (!ball.scored && currentUnder.contactReady && currentUnder.platform && ball.vy > 0) {
    const { a, b, forearms } = currentUnder.platform;

    // A forgiving hit region around both forearms and the space between them.
    const extra = Math.max(CONFIG.COLLISION_EXTRA_RADIUS, canvasCssHeight * 0.055);
    const tolerance = ball.radius + extra;

    const acrossPlatform = pointToSegmentDistance(ball.x, ball.y, a.x, a.y, b.x, b.y);
    const leftForearm = pointToSegmentDistance(ball.x, ball.y,
      forearms[0].a.x, forearms[0].a.y, forearms[0].b.x, forearms[0].b.y);
    const rightForearm = pointToSegmentDistance(ball.x, ball.y,
      forearms[1].a.x, forearms[1].a.y, forearms[1].b.x, forearms[1].b.y);

    const hitDistance = Math.min(acrossPlatform, leftForearm, rightForearm);

    if (hitDistance <= tolerance) {
      registerHit();
      return;
    }
  }

  if (ball.scored && ball.y < -ball.radius * 2) {
    spawnBall();
    return;
  }

  if (ball.y > canvasCssHeight + ball.radius * 2) {
    combo = 0;
    ui.combo.textContent = "x0";
    ui.tip.textContent = "ลูกตกแล้ว! จัดแนวท่อนแขนให้พร้อมสำหรับลูกถัดไป";
    spawnBall();
  }
}

function registerHit() {
  if (!ball || ball.scored) return;

  ball.scored = true;
  ball.vy = -Math.max(340, canvasCssHeight * 0.56);
  ball.vx += (Math.random() - 0.5) * 45;

  score += 1;
  combo += 1;
  ui.score.textContent = String(score);
  ui.combo.textContent = `x${combo}`;
  ui.missionCount.textContent = `${Math.min(score, 15)} / 15`;
  ui.missionProgress.style.width = `${Math.min(100, score / 15 * 100)}%`;
  if (score >= 15) {
    $("missionCount").textContent = "GOAL REACHED!";
  }
  ui.tip.textContent = currentUnder.good
    ? (combo >= 3 ? `🔥 ${combo} COMBO! PERFECT UNDER PASS` : "✨ PERFECT UNDER PASS! +1")
    : "✅ รับลูกได้! ลองเหยียดแขนให้ตรงขึ้นเพื่อท่าที่ดีขึ้น";

  showFeedback(currentUnder.good ? "PERFECT! +1" : "GOOD! +1");
  playScoreSound();
}

function drawVolleyball(x, y, radius) {
  ctx.save();
  ctx.translate(x, y);

  ctx.beginPath();
  ctx.ellipse(5, radius * 0.86, radius * 0.82, radius * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.fill();

  const gradient = ctx.createRadialGradient(-radius*.32, -radius*.35, radius*.08, 0, 0, radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(.72, "#edf2f7");
  gradient.addColorStop(1, "#aab7c9");

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius - 1, 0, Math.PI * 2);
  ctx.clip();

  ctx.strokeStyle = "#68778d";
  ctx.lineWidth = Math.max(2, radius * .075);

  ctx.beginPath();
  ctx.moveTo(-radius*.92, -radius*.18);
  ctx.bezierCurveTo(-radius*.25, -radius*.85, radius*.3, -radius*.82, radius*.92, -.05*radius);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-radius*.6, radius*.78);
  ctx.bezierCurveTo(-radius*.15, radius*.05, radius*.48, radius*.1, radius*.82, radius*.72);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-radius*.75, -radius*.65);
  ctx.bezierCurveTo(-radius*.25, -.05*radius, -radius*.15, radius*.4, radius*.35, radius*.92);
  ctx.stroke();

  ctx.restore();
  ctx.beginPath();
  ctx.arc(-radius*.3, -radius*.35, radius*.13, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.fill();
  ctx.restore();
}

function showFeedback(text) {
  ui.feedback.textContent = text;
  ui.feedback.classList.remove("hidden", "pop");
  void ui.feedback.offsetWidth;
  ui.feedback.classList.add("pop");
  window.setTimeout(() => ui.feedback.classList.add("hidden"), 700);
}

/* OPTIONAL GAME SOUND */
function initAudio() {
  if (!soundEnabled) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume();
  } catch (error) {
    console.warn("Audio is unavailable:", error);
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  ui.soundToggle.textContent = soundEnabled ? "🔊 เสียงเปิด" : "🔇 เสียงปิด";
  if (soundEnabled) {
    initAudio();
    playScoreSound();
  }
}

function playScoreSound() {
  if (!soundEnabled) return;
  try {
    initAudio();
    if (!audioContext || audioContext.state !== "running") return;
    const now = audioContext.currentTime;
    [520, 760].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.08);
      gain.gain.setValueAtTime(0.0001, now + index * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.12, now + index * 0.08 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.08 + 0.16);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now + index * 0.08);
      oscillator.stop(now + index * 0.08 + 0.17);
    });
  } catch (error) {
    console.warn("Could not play score sound:", error);
  }
}

/* CLEANUP AND RESULTS */
function stopCamera() {
  running = false;
  if (gameLoopId) cancelAnimationFrame(gameLoopId);
  gameLoopId = null;

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  ui.video.pause();
  ui.video.srcObject = null;
}

async function finishGame(saveResult) {
  if (finishing) return;
  finishing = true;
  stopCamera();
  phase = saveResult ? "result" : "home";

  if (!saveResult) {
    finishing = false;
    $("startBtn").disabled = false;
    showScreen(ui.home);
    return;
  }

  $("finalScore").textContent = String(score);
  $("resultName").textContent = ui.playerName.value.trim();
  $("resultHeadline").textContent = score >= 15 ? "ภารกิจสำเร็จ! 🌟" : "ยอดเยี่ยม! ฝึกต่ออีกนิด 💪";
  $("resultMissionText").textContent = score >= 15 ? "15-POINT MISSION CLEARED" : "MISSION: REACH 15 POINTS";
  $("saveStatus").textContent = "กำลังบันทึกคะแนน...";
  showScreen(ui.result);

  try {
    await apiJSONP({
      action: "save",
      name: ui.playerName.value.trim(),
      score: String(score)
    });
    $("saveStatus").textContent = "✅ บันทึกคะแนนเรียบร้อย";
  } catch (error) {
    console.error("Save score failed:", error);
    $("saveStatus").textContent = "⚠️ จบเกมแล้ว แต่บันทึกคะแนนไม่สำเร็จ";
  } finally {
    finishing = false;
    $("startBtn").disabled = false;
  }
}

function returnHome() {
  showScreen(ui.home);
  phase = "home";
  $("startBtn").disabled = false;
  renderInitialTimer();
  ui.progress.style.width = "0%";
}

/* GOOGLE APPS SCRIPT JSONP */
function apiJSONP(params) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.API_URL || !CONFIG.API_URL.startsWith("https://script.google.com/")) {
      reject(new Error("กรุณาตั้งค่า API_URL ใน app.js ให้เป็น URL /exec ของ Apps Script"));
      return;
    }

    const callbackName = `arvCallback_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const query = new URLSearchParams({ ...params, callback: callbackName });
    const script = document.createElement("script");
    let settled = false;

    const timeout = window.setTimeout(() => cleanup(new Error("หมดเวลารอ Google Apps Script API")), CONFIG.API_TIMEOUT_MS);

    function cleanup(error, data) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
      if (error) reject(error);
      else if (data && data.ok === false) reject(new Error(data.error || "API error"));
      else resolve(data);
    }

    window[callbackName] = data => cleanup(null, data);
    script.onerror = () => cleanup(new Error("โหลด Apps Script API ไม่สำเร็จ กรุณาตรวจสอบ URL และสิทธิ์ Deploy"));
    script.src = `${CONFIG.API_URL}?${query.toString()}`;
    document.body.appendChild(script);
  });
}

async function showLeaderboard() {
  ui.leaderboardModal.classList.remove("hidden");
  const list = $("leaderboardList");
  list.innerHTML = "<li>กำลังโหลดคะแนน...</li>";

  try {
    const response = await apiJSONP({ action: "leaderboard" });
    const rows = response.rows || [];
    if (!rows.length) {
      list.innerHTML = "<li>ยังไม่มีคะแนนการแข่งขัน</li>";
      return;
    }

    list.innerHTML = rows.map((row, index) =>
      `<li><b>#${index + 1}</b> ${escapeHTML(row.name)}<span>${Number(row.score) || 0}</span></li>`
    ).join("");
  } catch (error) {
    console.error("Leaderboard failed:", error);
    list.innerHTML = "<li>โหลดอันดับไม่สำเร็จ กรุณาตรวจสอบ Apps Script API</li>";
  }
}

/* HELPERS */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function calculateAngle(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const denominator = Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y);
  if (!denominator) return 0;
  const cosine = clamp((ba.x * bc.x + ba.y * bc.y) / denominator, -1, 1);
  return Math.acos(cosine) * 180 / Math.PI;
}
function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSquared, 0, 1);
  const nearestX = x1 + t * dx, nearestY = y1 + t * dy;
  return Math.hypot(px - nearestX, py - nearestY);
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
function getFriendlyErrorTitle(error) {
  if (error.name === "NotAllowedError" || error.message === "INSECURE_CONTEXT") return "เข้าใช้กล้องไม่ได้";
  if (error.message.includes("MediaPipe")) return "โหลดระบบ AI ไม่สำเร็จ";
  return "เริ่มเกมไม่สำเร็จ";
}
function getFriendlyErrorMessage(error) {
  if (error.message === "INSECURE_CONTEXT") return "เว็บไซต์ต้องเปิดผ่าน HTTPS เช่น GitHub Pages";
  if (error.message === "CAMERA_API_UNAVAILABLE") return "เบราว์เซอร์นี้ไม่รองรับ Camera API";
  if (error.name === "NotAllowedError") return "เบราว์เซอร์ปฏิเสธการใช้กล้อง กรุณาตรวจสอบสิทธิ์กล้องของ Safari";
  if (error.name === "NotFoundError") return "ไม่พบกล้องในอุปกรณ์";
  if (error.name === "NotReadableError") return "กล้องอาจกำลังถูกใช้งานโดยแอปอื่น";
  return error.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";
}
window.addEventListener("beforeunload", stopCamera);

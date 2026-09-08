// ============================================================
// 🚬 Smoking Simulator — Main Application Logic
// ============================================================
// Camera + MediaPipe Hand/Face Tracking + Smoke Particle Engine
// ============================================================

let video, handLandmarker, faceLandmarker;
let handWrist = { x: 0.5, y: 0.5 };
let lastTimestamp = -1;
let handDetected = false;

// MediaPipe module references (loaded dynamically in init)
let FilesetResolver, HandLandmarker, FaceLandmarker;

// Hand tracking state
let pinchHistory = [];
let handPosition = { x: 0, y: 0 }; // normalized
let isPinching = false;

// Face tracking state
let mouthPosition = { x: 0.5, y: 0.5 }; // normalized
let isMouthOpen = false;
let mouthOpenness = 0;

// Application state
let state = 'idle';
let inhaleTimer = 0;
let exhaleTimer = 0;
let puffCount = 0;
let burnLevel = 100;
const INHALE_FRAMES_REQUIRED = 30; // ~0.5s at 60fps
const EXHALE_DURATION = 90; // ~1.5s of smoke emission

// Cigarette positioning
let cigX = 0, cigY = 0;
const LERP_SPEED = 0.25;

// Particles
let particles = [];
const MAX_PARTICLES = 300;

// ============================================================
// LOADING STATUS HELPER
// ============================================================
function updateLoadingStatus(msg) {
  console.log('[SmokeSim]', msg);
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

// ============================================================
// CAMERA MODULE
// ============================================================
async function initCamera() {
  updateLoadingStatus('Requesting camera access...');
  const videoEl = document.getElementById('camera');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    videoEl.srcObject = stream;
    await new Promise((resolve, reject) => {
      videoEl.onloadedmetadata = resolve;
      videoEl.onerror = reject;
      // Timeout after 10 seconds
      setTimeout(() => reject(new Error('Camera metadata timeout')), 10000);
    });
    await videoEl.play();
    updateLoadingStatus('Camera ready!');
    return videoEl;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      updateLoadingStatus('❌ Camera access denied. Please allow camera and reload.');
    } else if (err.name === 'NotFoundError') {
      updateLoadingStatus('❌ No camera found. Please connect a webcam.');
    } else {
      updateLoadingStatus('❌ Camera error: ' + err.message);
    }
    throw err;
  }
}

function resizeCanvas() {
  const canvas = document.getElementById('smoke-canvas');
  const videoEl = document.getElementById('camera');
  canvas.width = videoEl.videoWidth || 1280;
  canvas.height = videoEl.videoHeight || 720;
}

// ============================================================
// HAND PROCESSING
// ============================================================
function processHands(results) {
  if (!results.landmarks || results.landmarks.length === 0) {
    isPinching = false;
    handDetected = false;
    pinchHistory = [];
    return;
  }

  handDetected = true;

  const landmarks = results.landmarks[0];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];

  // Euclidean distance (normalized coords)
  const dx = thumbTip.x - indexTip.x;
  const dy = thumbTip.y - indexTip.y;
  const dz = (thumbTip.z || 0) - (indexTip.z || 0);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Rolling average for smoothing (5-frame window)
  pinchHistory.push(distance < 0.06 ? 1 : 0);
  if (pinchHistory.length > 5) pinchHistory.shift();
  const avgPinch = pinchHistory.reduce((a, b) => a + b, 0) / pinchHistory.length;
  isPinching = avgPinch > 0.5;

  // Hand midpoint between thumb and index (where cigarette sits)
  // Video is mirrored, so flip X
  handPosition.x = 1.0 - (thumbTip.x + indexTip.x) / 2;
  handPosition.y = (thumbTip.y + indexTip.y) / 2;

  // Store wrist position for near-mouth detection
  handWrist.x = 1.0 - landmarks[0].x;
  handWrist.y = landmarks[0].y;
}

// ============================================================
// FACE PROCESSING
// ============================================================
function processFace(results) {
  if (!results.faceLandmarks || results.faceLandmarks.length === 0) return;

  const landmarks = results.faceLandmarks[0];
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];

  // Mouth center (mirrored X)
  mouthPosition.x = 1.0 - (upperLip.x + lowerLip.x) / 2;
  mouthPosition.y = (upperLip.y + lowerLip.y) / 2;

  // Mouth openness
  mouthOpenness = Math.abs(upperLip.y - lowerLip.y);

  // Also check blendshapes for robustness
  let jawOpenScore = 0;
  if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
    const jawOpen = results.faceBlendshapes[0].categories.find(
      c => c.categoryName === 'jawOpen'
    );
    if (jawOpen) jawOpenScore = jawOpen.score;
  }

  // Mouth is "open" if either metric exceeds threshold
  isMouthOpen = mouthOpenness > 0.02 || jawOpenScore > 0.3;
}

// ============================================================
// BURNED OUT HANDLER
// ============================================================
function handleBurnedOut() {
  const btn = document.getElementById('new-cig-btn');
  btn.classList.remove('hidden');
  btn.addEventListener('click', resetCigarette, { once: true });
}

function resetCigarette() {
  burnLevel = 100;
  puffCount = 0;
  document.getElementById('puff-count').textContent = '0';
  document.getElementById('burn-progress').style.width = '100%';
  document.getElementById('new-cig-btn').classList.add('hidden');
  state = 'idle';
}

// ============================================================
// STATE MACHINE
// ============================================================
function updateState() {
  const cigaretteEl = document.getElementById('cigarette');

  // Check if hand is near mouth
  const handToMouth = Math.sqrt(
    Math.pow(handPosition.x - mouthPosition.x, 2) +
    Math.pow(handPosition.y - mouthPosition.y, 2)
  );
  const isNearMouth = handToMouth < 0.12;

  // Remove all state classes first
  cigaretteEl.classList.remove('idle', 'holding', 'inhaling', 'exhaling');

  switch (state) {
    case 'idle':
      if (isPinching) state = 'holding';
      break;

    case 'holding':
      if (!isPinching) { state = 'idle'; break; }
      if (isNearMouth && isPinching) {
        state = 'inhaling';
        inhaleTimer = 0;
      }
      break;

    case 'inhaling':
      if (!isPinching) { state = 'idle'; inhaleTimer = 0; break; }
      if (!isNearMouth) {
        // Moved hand away — if we inhaled enough, exhale; otherwise just go back to holding
        if (inhaleTimer >= INHALE_FRAMES_REQUIRED) {
          state = 'exhaling';
          exhaleTimer = 0;
          puffCount++;
          burnLevel = Math.max(0, burnLevel - 8);
          document.getElementById('puff-count').textContent = puffCount;
          document.getElementById('burn-progress').style.width = burnLevel + '%';
          if (burnLevel <= 0) handleBurnedOut();
        } else {
          state = 'holding';
        }
        inhaleTimer = 0;
        break;
      }
      inhaleTimer++;

      // If mouth opens during inhale and enough time has passed, exhale
      if (inhaleTimer >= INHALE_FRAMES_REQUIRED && isMouthOpen) {
        state = 'exhaling';
        exhaleTimer = 0;
        puffCount++;
        burnLevel = Math.max(0, burnLevel - 8);
        document.getElementById('puff-count').textContent = puffCount;
        document.getElementById('burn-progress').style.width = burnLevel + '%';
        if (burnLevel <= 0) handleBurnedOut();
      }
      break;

    case 'exhaling':
      exhaleTimer++;
      if (exhaleTimer >= EXHALE_DURATION) {
        state = isPinching ? 'holding' : 'idle';
      }
      break;
  }

  cigaretteEl.classList.add(state);
}

// ============================================================
// CIGARETTE POSITIONING
// ============================================================
function updateCigarette() {
  const cigaretteEl = document.getElementById('cigarette');
  const canvas = document.getElementById('smoke-canvas');
  const rect = canvas.getBoundingClientRect();

  if (state === 'idle') {
    // Park at bottom center
    const targetX = rect.width / 2 - 60;
    const targetY = rect.height - 100;
    cigX += (targetX - cigX) * LERP_SPEED;
    cigY += (targetY - cigY) * LERP_SPEED;
  } else {
    // Follow hand position
    const targetX = handPosition.x * rect.width - 60;
    const targetY = handPosition.y * rect.height - 7;
    cigX += (targetX - cigX) * LERP_SPEED;
    cigY += (targetY - cigY) * LERP_SPEED;
  }

  cigaretteEl.style.transform = `translate(${cigX}px, ${cigY}px)`;

  // Update ash width based on burn
  const ashEl = cigaretteEl.querySelector('.cig-ash');
  if (ashEl) {
    const maxAsh = 20;
    const ashWidth = maxAsh * (1 - burnLevel / 100);
    ashEl.style.width = ashWidth + 'px';
  }
}

// ============================================================
// SMOKE PARTICLE ENGINE ⭐
// ============================================================
class SmokeParticle {
  constructor(x, y, type = 'exhale') {
    this.x = x;
    this.y = y;
    this.type = type;

    if (type === 'exhale') {
      this.vx = (Math.random() - 0.5) * 2;
      this.vy = -(Math.random() * 2 + 1); // rises upward
      this.radius = 3 + Math.random() * 5;
      this.maxRadius = 25 + Math.random() * 20;
      this.opacity = 0.4 + Math.random() * 0.2;
      this.life = 0;
      this.maxLife = 120 + Math.random() * 60; // 2-3 seconds
      this.turbulenceOffset = Math.random() * Math.PI * 2;
      this.turbulenceSpeed = 0.02 + Math.random() * 0.02;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    } else {
      // Idle smoke from cigarette tip — tiny and subtle
      this.vx = (Math.random() - 0.3) * 0.5;
      this.vy = -(Math.random() * 0.8 + 0.3);
      this.radius = 1 + Math.random() * 2;
      this.maxRadius = 8 + Math.random() * 5;
      this.opacity = 0.15 + Math.random() * 0.1;
      this.life = 0;
      this.maxLife = 60 + Math.random() * 40;
      this.turbulenceOffset = Math.random() * Math.PI * 2;
      this.turbulenceSpeed = 0.03 + Math.random() * 0.02;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    }
  }

  update() {
    this.life++;
    const progress = this.life / this.maxLife;

    // Turbulence: sine-wave horizontal drift
    this.vx += Math.sin(this.life * this.turbulenceSpeed + this.turbulenceOffset) * 0.1;

    // Slow down over time
    this.vx *= 0.99;
    this.vy *= 0.995;

    // Apply velocity
    this.x += this.vx;
    this.y += this.vy;

    // Grow radius
    this.radius += this.growRate;

    // Fade opacity — starts fading after 30% of life
    if (progress > 0.3) {
      this.opacity *= 0.98;
    }

    return this.life < this.maxLife && this.opacity > 0.01;
  }
}

function updateSmokeParticles() {
  const canvas = document.getElementById('smoke-canvas');
  const rect = canvas.getBoundingClientRect();

  // Spawn exhale particles
  if (state === 'exhaling' && exhaleTimer < EXHALE_DURATION * 0.7) {
    const spawnCount = exhaleTimer < 15 ? 12 : Math.max(1, 8 - Math.floor(exhaleTimer / 15));
    const mx = mouthPosition.x * canvas.width;
    const my = mouthPosition.y * canvas.height;
    for (let i = 0; i < spawnCount && particles.length < MAX_PARTICLES; i++) {
      particles.push(new SmokeParticle(
        mx + (Math.random() - 0.5) * 15,
        my + (Math.random() - 0.5) * 10,
        'exhale'
      ));
    }
  }

  // Spawn idle smoke from cigarette tip (only when not inhaling)
  if (state !== 'inhaling' && Math.random() < 0.15) {
    const emberX = cigX + 4;
    const emberY = cigY;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (particles.length < MAX_PARTICLES) {
      particles.push(new SmokeParticle(
        emberX * scaleX,
        emberY * scaleY,
        'idle'
      ));
    }
  }

  // Update all particles, remove dead ones
  particles = particles.filter(p => p.update());
}

function renderSmoke() {
  const canvas = document.getElementById('smoke-canvas');
  const ctx = canvas.getContext('2d');

  // Semi-transparent clear for ghosting/trail effect
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw particles
  ctx.globalCompositeOperation = 'source-over';

  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.opacity;

    // Radial gradient for each particle
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
    if (p.type === 'exhale') {
      grad.addColorStop(0, 'rgba(200, 200, 210, 0.6)');
      grad.addColorStop(0.4, 'rgba(180, 180, 195, 0.3)');
      grad.addColorStop(1, 'rgba(160, 160, 175, 0)');
    } else {
      grad.addColorStop(0, 'rgba(180, 180, 190, 0.4)');
      grad.addColorStop(1, 'rgba(160, 160, 170, 0)');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ============================================================
// MAIN DETECTION LOOP
// ============================================================
function detect() {
  const now = performance.now();
  if (now === lastTimestamp) { requestAnimationFrame(detect); return; }
  lastTimestamp = now;

  try {
    if (handLandmarker && video) {
      const handResults = handLandmarker.detectForVideo(video, now);
      processHands(handResults);
    }

    if (faceLandmarker && video) {
      const faceResults = faceLandmarker.detectForVideo(video, now);
      processFace(faceResults);
    }
  } catch (e) {
    // MediaPipe can occasionally throw on bad frames; skip gracefully
    console.warn('Detection frame skipped:', e.message);
  }

  updateState();
  updateCigarette();
  updateSmokeParticles();
  renderSmoke();

  // Update status indicator
  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) {
    if (state === 'inhaling') statusTextEl.textContent = 'Inhaling...';
    else if (state === 'exhaling') statusTextEl.textContent = 'Exhaling 💨';
    else if (handDetected) statusTextEl.textContent = isPinching ? 'Holding 🚬' : 'Hand Detected ✋';
    else statusTextEl.textContent = 'Ready';
  }

  requestAnimationFrame(detect);
}

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
  try {
    // Step 1: Load MediaPipe library from CDN
    updateLoadingStatus('Loading AI libraries...');
    console.log('[SmokeSim] Loading MediaPipe from CDN...');

    try {
      const vision = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm'
      );
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker = vision.HandLandmarker;
      FaceLandmarker = vision.FaceLandmarker;
      console.log('[SmokeSim] MediaPipe loaded successfully');
    } catch (importErr) {
      console.error('[SmokeSim] CDN import failed, trying alternate CDN...', importErr);
      // Fallback: try unpkg
      const vision = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs'
      );
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker = vision.HandLandmarker;
      FaceLandmarker = vision.FaceLandmarker;
      console.log('[SmokeSim] MediaPipe loaded from fallback CDN');
    }

    // Step 2: Initialize camera
    updateLoadingStatus('Requesting camera access...');
    video = await initCamera();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Step 3: Initialize hand tracking
    updateLoadingStatus('Loading hand tracking model...');
    console.log('[SmokeSim] Initializing FilesetResolver...');
    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
    );

    console.log('[SmokeSim] Creating HandLandmarker...');
    handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1
    });
    console.log('[SmokeSim] HandLandmarker ready');

    // Step 4: Initialize face tracking
    updateLoadingStatus('Loading face tracking model...');
    console.log('[SmokeSim] Creating FaceLandmarker...');
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true
    });
    console.log('[SmokeSim] FaceLandmarker ready');

    // Step 5: Hide loading screen and start
    updateLoadingStatus('All systems go! 🚬');
    setTimeout(() => {
      document.getElementById('loading-screen').classList.add('hidden');
    }, 500);
    const statusTextEl = document.getElementById('status-text');
    if (statusTextEl) statusTextEl.textContent = 'Ready';

    // Start detection loop
    console.log('[SmokeSim] Starting detection loop');
    detect();

  } catch (err) {
    console.error('[SmokeSim] Init failed:', err);
    updateLoadingStatus('❌ Error: ' + err.message + ' — Check console (F12) for details.');
  }
}

// Start the app
init();

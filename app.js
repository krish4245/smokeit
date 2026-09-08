// ============================================================
// 🚬 Smoke It — Main Application Logic
// ============================================================
// Camera + MediaPipe Tracking + Custom Smoke Engine (Rings, Colors & Devices)
// ============================================================

let video, handLandmarker, faceLandmarker;
let handWrist = { x: 0.5, y: 0.5 };
let lastTimestamp = -1;
let handDetected = false;

// MediaPipe module references
let FilesetResolver, HandLandmarker, FaceLandmarker;

// Tracking state
let pinchHistory = [];
let handPosition = { x: 0, y: 0 }; // normalized
let isPinching = false;
let mouthPosition = { x: 0.5, y: 0.5 }; // normalized
let isMouthOpen = false;
let mouthOpenness = 0;

// Application state
let state = 'idle';
let inhaleTimer = 0;
let exhaleTimer = 0;
let puffCount = 0;
let burnLevel = 100;
let currentDevice = 'cigarette'; // 'cigarette', 'vape', 'hookah'
let currentSmokeColor = 'classic'; // 'classic', 'ice', 'grape', 'mint', 'sunset', 'rose', 'lemon'
let ringModeEnabled = false;

const INHALE_FRAMES_REQUIRED = 25; // ~0.4s
const EXHALE_DURATION = 90; // ~1.5s

// Color palettes for smoke
const SMOKE_PALETTES = {
  classic: { r: 200, g: 200, b: 210, name: 'Classic' },
  ice:     { r: 100, g: 200, b: 255, name: 'Ice Blue' },
  grape:   { r: 180, g: 100, b: 255, name: 'Grape' },
  mint:    { r: 100, g: 240, b: 160, name: 'Mint' },
  sunset:  { r: 255, g: 140, b: 80,  name: 'Sunset' },
  rose:    { r: 255, g: 120, b: 180, name: 'Rose' },
  lemon:   { r: 255, g: 240, b: 100, name: 'Lemon' }
};

// Device positioning lerp
let deviceX = 0, deviceY = 0;
const LERP_SPEED = 0.25;

// Smoke Particles
let particles = [];
const MAX_PARTICLES = 400;

function updateLoadingStatus(msg) {
  console.log('[SmokeSim]', msg);
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

// Camera initialization
async function initCamera() {
  updateLoadingStatus('Requesting camera access...');
  const videoEl = document.getElementById('camera');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    videoEl.srcObject = stream;
    await new Promise((resolve, reject) => {
      videoEl.onloadedmetadata = resolve;
      videoEl.onerror = reject;
      setTimeout(() => reject(new Error('Camera metadata timeout')), 10000);
    });
    await videoEl.play();
    updateLoadingStatus('Camera ready!');
    return videoEl;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      updateLoadingStatus('❌ Camera access denied. Please allow camera and reload.');
    } else if (err.name === 'NotFoundError') {
      updateLoadingStatus('❌ No camera found. Connect a webcam.');
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

// Hand landmarks processing
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

  const dx = thumbTip.x - indexTip.x;
  const dy = thumbTip.y - indexTip.y;
  const dz = (thumbTip.z || 0) - (indexTip.z || 0);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  pinchHistory.push(distance < 0.065 ? 1 : 0);
  if (pinchHistory.length > 5) pinchHistory.shift();
  const avgPinch = pinchHistory.reduce((a, b) => a + b, 0) / pinchHistory.length;
  isPinching = avgPinch > 0.5;

  handPosition.x = 1.0 - (thumbTip.x + indexTip.x) / 2;
  handPosition.y = (thumbTip.y + indexTip.y) / 2;

  handWrist.x = 1.0 - landmarks[0].x;
  handWrist.y = landmarks[0].y;
}

// Face landmarks processing
function processFace(results) {
  if (!results.faceLandmarks || results.faceLandmarks.length === 0) return;

  const landmarks = results.faceLandmarks[0];
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];

  mouthPosition.x = 1.0 - (upperLip.x + lowerLip.x) / 2;
  mouthPosition.y = (upperLip.y + lowerLip.y) / 2;

  mouthOpenness = Math.abs(upperLip.y - lowerLip.y);

  let jawOpenScore = 0;
  if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
    const jawOpen = results.faceBlendshapes[0].categories.find(c => c.categoryName === 'jawOpen');
    if (jawOpen) jawOpenScore = jawOpen.score;
  }

  isMouthOpen = mouthOpenness > 0.02 || jawOpenScore > 0.3;
}

function handleBurnedOut() {
  if (currentDevice !== 'cigarette') return;
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

// State Machine
function updateState() {
  const currentDeviceEl = getActiveDeviceElement();

  const handToMouth = Math.sqrt(
    Math.pow(handPosition.x - mouthPosition.x, 2) +
    Math.pow(handPosition.y - mouthPosition.y, 2)
  );
  const isNearMouth = handToMouth < 0.13;

  currentDeviceEl.classList.remove('idle', 'holding', 'inhaling', 'exhaling');

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
        if (inhaleTimer >= INHALE_FRAMES_REQUIRED) {
          state = 'exhaling';
          exhaleTimer = 0;
          puffCount++;
          if (currentDevice === 'cigarette') {
            burnLevel = Math.max(0, burnLevel - 8);
            document.getElementById('burn-progress').style.width = burnLevel + '%';
            if (burnLevel <= 0) handleBurnedOut();
          }
          document.getElementById('puff-count').textContent = puffCount;
        } else {
          state = 'holding';
        }
        inhaleTimer = 0;
        break;
      }
      inhaleTimer++;

      if (inhaleTimer >= INHALE_FRAMES_REQUIRED && isMouthOpen) {
        state = 'exhaling';
        exhaleTimer = 0;
        puffCount++;
        if (currentDevice === 'cigarette') {
          burnLevel = Math.max(0, burnLevel - 8);
          document.getElementById('burn-progress').style.width = burnLevel + '%';
          if (burnLevel <= 0) handleBurnedOut();
        }
        document.getElementById('puff-count').textContent = puffCount;
      }
      break;

    case 'exhaling':
      exhaleTimer++;
      if (exhaleTimer >= EXHALE_DURATION) {
        state = isPinching ? 'holding' : 'idle';
      }
      break;
  }

  currentDeviceEl.classList.add(state);
}

function getActiveDeviceElement() {
  if (currentDevice === 'vape') return document.getElementById('vape');
  if (currentDevice === 'hookah') return document.getElementById('hookah');
  return document.getElementById('cigarette');
}

// Device Positioning
function updateDevicePosition() {
  const deviceEl = getActiveDeviceElement();
  const canvas = document.getElementById('smoke-canvas');
  const rect = canvas.getBoundingClientRect();

  if (state === 'idle') {
    const targetX = rect.width / 2 - 50;
    const targetY = rect.height - 100;
    deviceX += (targetX - deviceX) * LERP_SPEED;
    deviceY += (targetY - deviceY) * LERP_SPEED;
  } else {
    const targetX = handPosition.x * rect.width - 50;
    const targetY = handPosition.y * rect.height - 10;
    deviceX += (targetX - deviceX) * LERP_SPEED;
    deviceY += (targetY - deviceY) * LERP_SPEED;
  }

  deviceEl.style.transform = `translate(${deviceX}px, ${deviceY}px)`;

  if (currentDevice === 'cigarette') {
    const ashEl = deviceEl.querySelector('.cig-ash');
    if (ashEl) {
      const maxAsh = 20;
      const ashWidth = maxAsh * (1 - burnLevel / 100);
      ashEl.style.width = ashWidth + 'px';
    }
  }
}

// ============================================================
// ENHANCED SMOKE ENGINE (Clouds + Smoke Rings)
// ============================================================
class SmokeParticle {
  constructor(x, y, type = 'exhale', isRing = false) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.isRing = isRing;

    const palette = SMOKE_PALETTES[currentSmokeColor] || SMOKE_PALETTES.classic;
    this.color = palette;

    if (this.isRing) {
      // Ring particle properties
      this.vx = (Math.random() - 0.5) * 0.5;
      this.vy = -(Math.random() * 2.5 + 2.0); // Moves up fast
      this.radius = 8;
      this.maxRadius = 50 + Math.random() * 25; // Expands into large ring
      this.ringThickness = 6 + Math.random() * 4;
      this.opacity = 0.7 + Math.random() * 0.2;
      this.life = 0;
      this.maxLife = 140 + Math.random() * 40;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    } else if (type === 'exhale') {
      // Regular Exhale Smoke Cloud
      const deviceMult = currentDevice === 'vape' ? 1.8 : currentDevice === 'hookah' ? 1.4 : 1.0;
      this.vx = (Math.random() - 0.5) * (2.5 * deviceMult);
      this.vy = -(Math.random() * 2.2 + 1.2);
      this.radius = (4 + Math.random() * 6) * deviceMult;
      this.maxRadius = (30 + Math.random() * 25) * deviceMult;
      this.opacity = (0.45 + Math.random() * 0.25) * (currentDevice === 'vape' ? 1.3 : 1.0);
      this.life = 0;
      this.maxLife = 130 + Math.random() * 50;
      this.turbulenceOffset = Math.random() * Math.PI * 2;
      this.turbulenceSpeed = 0.02 + Math.random() * 0.02;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    } else {
      // Idle smoke
      this.vx = (Math.random() - 0.3) * 0.4;
      this.vy = -(Math.random() * 0.8 + 0.3);
      this.radius = 1.5 + Math.random() * 2;
      this.maxRadius = 8 + Math.random() * 5;
      this.opacity = 0.2 + Math.random() * 0.1;
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

    if (!this.isRing) {
      this.vx += Math.sin(this.life * this.turbulenceSpeed + this.turbulenceOffset) * 0.08;
    }

    this.vx *= 0.99;
    this.vy *= 0.992;

    this.x += this.vx;
    this.y += this.vy;

    this.radius += this.growRate;

    if (progress > 0.35) {
      this.opacity *= 0.975;
    }

    return this.life < this.maxLife && this.opacity > 0.01;
  }
}

function updateSmokeParticles() {
  const canvas = document.getElementById('smoke-canvas');

  // Spawn Exhale Smoke
  if (state === 'exhaling' && exhaleTimer < EXHALE_DURATION * 0.75) {
    const mx = mouthPosition.x * canvas.width;
    const my = mouthPosition.y * canvas.height;

    if (ringModeEnabled) {
      // Spawn Smoke Rings periodically (every 18 frames)
      if (exhaleTimer % 18 === 1 && particles.length < MAX_PARTICLES) {
        particles.push(new SmokeParticle(
          mx,
          my - 10,
          'exhale',
          true // isRing
        ));
      }
    } else {
      // Regular Cloud Exhale
      const mult = currentDevice === 'vape' ? 2.0 : 1.0;
      const spawnCount = Math.floor((exhaleTimer < 15 ? 12 : Math.max(1, 8 - Math.floor(exhaleTimer / 15))) * mult);

      for (let i = 0; i < spawnCount && particles.length < MAX_PARTICLES; i++) {
        particles.push(new SmokeParticle(
          mx + (Math.random() - 0.5) * 20,
          my + (Math.random() - 0.5) * 12,
          'exhale',
          false
        ));
      }
    }
  }

  // Spawn Idle smoke from tip
  if (state !== 'inhaling' && Math.random() < 0.2) {
    const scaleX = canvas.width / window.innerWidth;
    const scaleY = canvas.height / window.innerHeight;
    const tipX = deviceX + 4;
    const tipY = deviceY;

    if (particles.length < MAX_PARTICLES) {
      particles.push(new SmokeParticle(
        tipX * scaleX,
        tipY * scaleY,
        'idle',
        false
      ));
    }
  }

  particles = particles.filter(p => p.update());
}

function renderSmoke() {
  const canvas = document.getElementById('smoke-canvas');
  const ctx = canvas.getContext('2d');

  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'source-over';

  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.opacity);

    const { r, g, b } = p.color;

    if (p.isRing) {
      // Render Toroidal Smoke Ring
      ctx.lineWidth = p.ringThickness;
      const ringGrad = ctx.createRadialGradient(p.x, p.y, p.radius - p.ringThickness, p.x, p.y, p.radius + p.ringThickness);
      ringGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
      ringGrad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.8)`);
      ringGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      ctx.strokeStyle = ringGrad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();

      // Soft inner glow for ring
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.15)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * 0.8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Render Volumetric Particle Cloud
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      if (p.type === 'exhale') {
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.65)`);
        grad.addColorStop(0.5, `rgba(${r - 20}, ${g - 20}, ${b - 15}, 0.35)`);
        grad.addColorStop(1, `rgba(${r - 30}, ${g - 30}, ${b - 25}, 0)`);
      } else {
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.4)`);
        grad.addColorStop(1, `rgba(${r - 20}, ${g - 20}, ${b - 20}, 0)`);
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Detection Loop
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
    console.warn('Detection frame skipped:', e.message);
  }

  updateState();
  updateDevicePosition();
  updateSmokeParticles();
  renderSmoke();

  const statusTextEl = document.getElementById('status-text');
  if (statusTextEl) {
    if (state === 'inhaling') statusTextEl.textContent = 'Inhaling...';
    else if (state === 'exhaling') statusTextEl.textContent = ringModeEnabled ? 'Blowing Rings 🫧' : 'Exhaling 💨';
    else if (handDetected) statusTextEl.textContent = isPinching ? `Holding ${getDeviceEmoji()}` : 'Hand Detected ✋';
    else statusTextEl.textContent = 'Ready';
  }

  requestAnimationFrame(detect);
}

function getDeviceEmoji() {
  if (currentDevice === 'vape') return '💨';
  if (currentDevice === 'hookah') return '🫧';
  return '🚬';
}

// UI Event Listeners setup
function setupUIListeners() {
  // Device Selection
  document.querySelectorAll('.selector-device').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const device = btn.getAttribute('data-device');
      switchDevice(device);
    });
  });

  // Color Selection
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      currentSmokeColor = dot.getAttribute('data-color');
    });
  });

  // Ring Mode Toggle
  const ringCheck = document.getElementById('ring-mode-check');
  if (ringCheck) {
    ringCheck.addEventListener('change', (e) => {
      ringModeEnabled = e.target.checked;
    });
  }
}

function switchDevice(device) {
  currentDevice = device;

  document.querySelectorAll('.selector-device').forEach(d => {
    d.classList.toggle('active', d.getAttribute('data-device') === device);
  });

  document.getElementById('cigarette').style.display = device === 'cigarette' ? 'block' : 'none';
  document.getElementById('vape').style.display = device === 'vape' ? 'block' : 'none';
  document.getElementById('hookah').style.display = device === 'hookah' ? 'block' : 'none';

  // Hide burn bar for vape/hookah, show for cigarette
  const burnBarContainer = document.querySelector('.hud-top-right');
  if (burnBarContainer) {
    burnBarContainer.style.display = device === 'cigarette' ? 'block' : 'none';
  }
}

// App Initialization
async function init() {
  try {
    setupUIListeners();
    updateLoadingStatus('Loading AI libraries...');

    try {
      const vision = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm'
      );
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker = vision.HandLandmarker;
      FaceLandmarker = vision.FaceLandmarker;
      console.log('[SmokeSim] MediaPipe loaded via jsDelivr +esm');
    } catch (importErr) {
      console.warn('[SmokeSim] +esm import failed, trying bundle fallback...', importErr);
      const vision = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs'
      );
      FilesetResolver = vision.FilesetResolver;
      HandLandmarker = vision.HandLandmarker;
      FaceLandmarker = vision.FaceLandmarker;
    }

    updateLoadingStatus('Requesting camera access...');
    video = await initCamera();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    updateLoadingStatus('Loading hand tracking model...');
    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
    );

    handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1
    });

    updateLoadingStatus('Loading face tracking model...');
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

    updateLoadingStatus('All systems ready! 🚬💨');
    setTimeout(() => {
      document.getElementById('loading-screen').classList.add('hidden');
    }, 400);

    const statusTextEl = document.getElementById('status-text');
    if (statusTextEl) statusTextEl.textContent = 'Ready';

    detect();
  } catch (err) {
    console.error('[SmokeSim] Init failed:', err);
    updateLoadingStatus('❌ Error: ' + err.message + ' — Check console (F12)');
  }
}

init();

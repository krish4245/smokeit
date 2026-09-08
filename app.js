// ============================================================
// 🚬 Smoke It — Main Application Logic
// ============================================================
// Camera + MediaPipe Tracking + Sound Effects + High-Performance Engine
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

const INHALE_FRAMES_REQUIRED = 20; // ~0.3s
const EXHALE_DURATION = 80; // ~1.3s

// Color palettes for smoke
const SMOKE_PALETTES = {
  classic: { r: 210, g: 210, b: 220, name: 'Classic' },
  ice:     { r: 90,  g: 210, b: 255, name: 'Ice Blue' },
  grape:   { r: 190, g: 110, b: 255, name: 'Grape' },
  mint:    { r: 100, g: 245, b: 170, name: 'Mint' },
  sunset:  { r: 255, g: 150, b: 90,  name: 'Sunset' },
  rose:    { r: 255, g: 130, b: 190, name: 'Rose' },
  lemon:   { r: 255, g: 245, b: 110, name: 'Lemon' }
};

// Device positioning lerp
let deviceX = 0, deviceY = 0;
const LERP_SPEED = 0.28;

// Optimized Smoke Particles
let particles = [];
const MAX_PARTICLES = 160; // Optimized limit for smooth 60fps

// ============================================================
// WEB AUDIO SOUND EFFECTS GENERATOR (Zero Assets Needed!)
// ============================================================
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Inhale Crackle/Sizzle Sound
let inhaleBufferNode = null;
let inhaleGainNode = null;

function startInhaleSound() {
  initAudio();
  if (!audioCtx) return;

  try {
    stopInhaleSound();

    const bufferSize = audioCtx.sampleRate * 2; // 2 seconds
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      // Crackling noise for ember burn / vape sizzle
      const white = Math.random() * 2 - 1;
      const crackle = Math.random() < 0.08 ? (Math.random() - 0.5) * 3 : 0;
      data[i] = white * 0.15 + crackle * 0.4;
    }

    inhaleBufferNode = audioCtx.createBufferSource();
    inhaleBufferNode.buffer = buffer;
    inhaleBufferNode.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(currentDevice === 'vape' ? 2400 : 1600, audioCtx.currentTime);
    filter.Q.setValueAtTime(1.5, audioCtx.currentTime);

    inhaleGainNode = audioCtx.createGain();
    inhaleGainNode.gain.setValueAtTime(0.01, audioCtx.currentTime);
    inhaleGainNode.gain.linearRampToValueAtTime(0.18, audioCtx.currentTime + 0.2);

    inhaleBufferNode.connect(filter);
    filter.connect(inhaleGainNode);
    inhaleGainNode.connect(audioCtx.destination);

    inhaleBufferNode.start();
  } catch (e) {
    console.warn('Inhale sound error:', e);
  }
}

function stopInhaleSound() {
  if (inhaleGainNode && audioCtx) {
    try {
      inhaleGainNode.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      setTimeout(() => {
        if (inhaleBufferNode) {
          inhaleBufferNode.stop();
          inhaleBufferNode.disconnect();
          inhaleBufferNode = null;
        }
      }, 120);
    } catch (e) {}
  }
}

// Exhale Air Whoosh Sound
function playExhaleSound() {
  initAudio();
  if (!audioCtx) return;

  try {
    const duration = 1.2;
    const bufferSize = audioCtx.sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(120, audioCtx.currentTime + duration);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.01, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(currentDevice === 'vape' ? 0.35 : 0.22, audioCtx.currentTime + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    noise.start();
  } catch (e) {}
}

// Ring Spawn Pop Sound
function playRingPopSound() {
  initAudio();
  if (!audioCtx) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, audioCtx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}

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

// State Machine with Audio Triggers
function updateState() {
  const currentDeviceEl = getActiveDeviceElement();

  const handToMouth = Math.sqrt(
    Math.pow(handPosition.x - mouthPosition.x, 2) +
    Math.pow(handPosition.y - mouthPosition.y, 2)
  );
  const isNearMouth = handToMouth < 0.13;

  const prevState = state;
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
      if (!isPinching) {
        state = 'idle';
        inhaleTimer = 0;
        stopInhaleSound();
        break;
      }
      if (!isNearMouth) {
        if (inhaleTimer >= INHALE_FRAMES_REQUIRED) {
          state = 'exhaling';
          exhaleTimer = 0;
          puffCount++;
          triggerPuffEffects();
        } else {
          state = 'holding';
        }
        inhaleTimer = 0;
        stopInhaleSound();
        break;
      }
      inhaleTimer++;

      if (inhaleTimer >= INHALE_FRAMES_REQUIRED && isMouthOpen) {
        state = 'exhaling';
        exhaleTimer = 0;
        puffCount++;
        triggerPuffEffects();
        stopInhaleSound();
      }
      break;

    case 'exhaling':
      exhaleTimer++;
      if (exhaleTimer >= EXHALE_DURATION) {
        state = isPinching ? 'holding' : 'idle';
      }
      break;
  }

  // Handle Sound Effects Triggers
  if (prevState !== 'inhaling' && state === 'inhaling') {
    startInhaleSound();
  } else if (prevState === 'inhaling' && state !== 'inhaling') {
    stopInhaleSound();
  }

  if (prevState !== 'exhaling' && state === 'exhaling') {
    playExhaleSound();
  }

  currentDeviceEl.classList.add(state);
}

function triggerPuffEffects() {
  if (currentDevice === 'cigarette') {
    burnLevel = Math.max(0, burnLevel - 8);
    document.getElementById('burn-progress').style.width = burnLevel + '%';
    if (burnLevel <= 0) handleBurnedOut();
  }
  document.getElementById('puff-count').textContent = puffCount;
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
// HIGH-PERFORMANCE SMOKE ENGINE (Rings + Clouds)
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
      this.vx = (Math.random() - 0.5) * 0.4;
      this.vy = -(Math.random() * 2.2 + 2.0); // Fast upward stream
      this.radius = 12;
      this.maxRadius = 55 + Math.random() * 20; // Ring expansion
      this.ringThickness = 5 + Math.random() * 3;
      this.opacity = 0.85;
      this.life = 0;
      this.maxLife = 90 + Math.random() * 20; // Optimized shorter life
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    } else if (type === 'exhale') {
      // Cloud particle properties
      const deviceMult = currentDevice === 'vape' ? 1.5 : currentDevice === 'hookah' ? 1.3 : 1.0;
      this.vx = (Math.random() - 0.5) * (2.2 * deviceMult);
      this.vy = -(Math.random() * 1.8 + 1.0);
      this.radius = (5 + Math.random() * 5) * deviceMult;
      this.maxRadius = (28 + Math.random() * 20) * deviceMult;
      this.opacity = 0.5 * (currentDevice === 'vape' ? 1.2 : 1.0);
      this.life = 0;
      this.maxLife = 85 + Math.random() * 25; // Faster decay = zero lag!
      this.turbulenceOffset = Math.random() * Math.PI * 2;
      this.turbulenceSpeed = 0.03;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    } else {
      // Idle smoke from tip
      this.vx = (Math.random() - 0.3) * 0.3;
      this.vy = -(Math.random() * 0.7 + 0.3);
      this.radius = 1.5;
      this.maxRadius = 7;
      this.opacity = 0.25;
      this.life = 0;
      this.maxLife = 45;
      this.turbulenceOffset = Math.random() * Math.PI * 2;
      this.turbulenceSpeed = 0.04;
      this.growRate = (this.maxRadius - this.radius) / this.maxLife;
    }
  }

  update() {
    this.life++;
    const progress = this.life / this.maxLife;

    if (!this.isRing) {
      this.vx += Math.sin(this.life * this.turbulenceSpeed + this.turbulenceOffset) * 0.07;
    }

    this.vx *= 0.985;
    this.vy *= 0.99;

    this.x += this.vx;
    this.y += this.vy;

    this.radius += this.growRate;

    if (progress > 0.3) {
      this.opacity *= 0.96;
    }

    return this.life < this.maxLife && this.opacity > 0.01;
  }
}

function updateSmokeParticles() {
  const canvas = document.getElementById('smoke-canvas');

  // Spawn Exhale Smoke
  if (state === 'exhaling' && exhaleTimer < EXHALE_DURATION * 0.7) {
    const mx = mouthPosition.x * canvas.width;
    const my = mouthPosition.y * canvas.height;

    if (ringModeEnabled) {
      // Spawn Smoke Ring every 20 frames
      if (exhaleTimer % 20 === 1 && particles.length < MAX_PARTICLES) {
        particles.push(new SmokeParticle(mx, my - 10, 'exhale', true));
        playRingPopSound(); // Ring sound trigger
      }
    } else {
      // Optimized Cloud Exhale
      const mult = currentDevice === 'vape' ? 1.5 : 1.0;
      const spawnCount = Math.floor((exhaleTimer < 12 ? 5 : Math.max(1, 4 - Math.floor(exhaleTimer / 18))) * mult);

      for (let i = 0; i < spawnCount && particles.length < MAX_PARTICLES; i++) {
        particles.push(new SmokeParticle(
          mx + (Math.random() - 0.5) * 16,
          my + (Math.random() - 0.5) * 10,
          'exhale',
          false
        ));
      }
    }
  }

  // Spawn Idle smoke
  if (state !== 'inhaling' && Math.random() < 0.25) {
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

  // Fast clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.opacity);

    const { r, g, b } = p.color;

    if (p.isRing) {
      // High Performance Ring Rendering
      ctx.lineWidth = p.ringThickness;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${p.opacity * 0.9})`;
      ctx.beginPath();
      ctx.arc(p.x | 0, p.y | 0, p.radius | 0, 0, Math.PI * 2);
      ctx.stroke();

      // Soft center halo
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${p.opacity * 0.12})`;
      ctx.beginPath();
      ctx.arc(p.x | 0, p.y | 0, (p.radius * 0.85) | 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // High Performance Particle Cloud
      const grad = ctx.createRadialGradient(p.x | 0, p.y | 0, 0, p.x | 0, p.y | 0, p.radius | 0);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.6)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x | 0, p.y | 0, p.radius | 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Detection Loop with Frame Throttling
let isProcessingFrame = false;

function detect() {
  const now = performance.now();
  if (now === lastTimestamp) { requestAnimationFrame(detect); return; }
  lastTimestamp = now;

  // Run MediaPipe inference non-blocking
  if (!isProcessingFrame) {
    isProcessingFrame = true;
    try {
      if (handLandmarker && video && video.readyState >= 2) {
        const handResults = handLandmarker.detectForVideo(video, now);
        processHands(handResults);
      }
      if (faceLandmarker && video && video.readyState >= 2) {
        const faceResults = faceLandmarker.detectForVideo(video, now);
        processFace(faceResults);
      }
    } catch (e) {
      console.warn('Detection skipped:', e.message);
    } finally {
      isProcessingFrame = false;
    }
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

// UI Event Listeners
function setupUIListeners() {
  document.addEventListener('click', initAudio, { once: true });
  document.addEventListener('touchstart', initAudio, { once: true });

  document.querySelectorAll('.selector-device').forEach(btn => {
    btn.addEventListener('click', () => {
      initAudio();
      const device = btn.getAttribute('data-device');
      switchDevice(device);
    });
  });

  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      initAudio();
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      currentSmokeColor = dot.getAttribute('data-color');
    });
  });

  const ringCheck = document.getElementById('ring-mode-check');
  if (ringCheck) {
    ringCheck.addEventListener('change', (e) => {
      initAudio();
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
    } catch (importErr) {
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

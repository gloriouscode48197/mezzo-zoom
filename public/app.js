import { AudioProcessor } from './src/audio.js';
import { MezzoEngine, LogicalState } from './src/engine.js';
import { MezzoVoiceCircle } from './src/voice-circle.js';

// ── Zoom SDK init ──
let zoomReady = false;

async function initZoom() {
  try {
    await zoomSdk.config({
      capabilities: [
        'getSupportedJsApis',
        'getMeetingContext',
        'getUserContext',
        'showNotification',
        'openUrl',
      ],
      version: '0.16',
    });
    zoomReady = true;
  } catch (e) {
    console.warn('[Zoom] SDK config failed (expected outside Zoom):', e.message);
  }
}

async function notify(title, message) {
  if (!zoomReady) return;
  try {
    await zoomSdk.showNotification({ type: 'info', title, message });
  } catch (e) {
    console.warn('[Zoom] showNotification failed:', e.message);
  }
}

// ── DOM ──
const body = document.body;
const btnCalibrate = document.getElementById('btn-calibrate');
const btnStart = document.getElementById('btn-start');
const debugMsg = document.getElementById('debug-msg');
const btnStop = document.getElementById('btn-stop');
const btnRecalibrate = document.getElementById('btn-recalibrate');
const progressBar = document.getElementById('progress-bar');
const calCircleContainer = document.getElementById('cal-circle-container');
const circleContainer = document.getElementById('circle-container');
const monCard = document.getElementById('mon-card');
const stateHeading = document.getElementById('state-heading');

// ── Audio & Engine ──
const audio = new AudioProcessor();
const engine = new MezzoEngine();
let circle = null;
let baselineRMS = 0;

let isAlertMode = false;
let isOutsideRange = false;
let sustainedTimer = null;
let fastBlinkTimer = null;
let blinkInterval = null;

const CALIBRATION_MS = 4000;
const SUSTAINED_ALERT_MS = 500;
const SLOW_BLINK_MS = 1000;
const FAST_BLINK_MS = 400;
const FAST_BLINK_AFTER_MS = 2500;

// ── Screens ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Calibration ──
btnCalibrate.addEventListener('click', async () => {
  debugMsg.textContent = 'Button clicked…';
  btnCalibrate.disabled = true;
  showScreen('screen-calibrating');

  // Show a live circle while calibrating
  const calCircle = new MezzoVoiceCircle(calCircleContainer, { assetPath: 'assets' });

  try {
    debugMsg.textContent = 'Requesting mic…';
    await audio.acquire();
    debugMsg.textContent = 'Mic acquired';
  } catch (err) {
    debugMsg.textContent = 'Mic error: ' + (err?.message || err);
    calCircle.destroy();
    showScreen('screen-calibrate');
    btnCalibrate.disabled = false;
    return;
  }

  const samples = [];
  const startTime = Date.now();

  audio.onLevelChange = ({ rms }) => {
    samples.push(rms);
    const elapsed = Date.now() - startTime;
    progressBar.style.width = `${Math.min(100, (elapsed / CALIBRATION_MS) * 100)}%`;
    calCircle.update(rms, rms * 0.8, false, false);
  };
  audio.startMonitoring();

  setTimeout(() => {
    audio.stopMonitoring();
    audio.release();
    audio.onLevelChange = null;
    calCircle.destroy();

    try {
      engine.calibrate(samples);
      baselineRMS = engine.baselineRMS;
      showScreen('screen-ready');
    } catch {
      btnCalibrate.disabled = false;
      showScreen('screen-calibrate');
    }
  }, CALIBRATION_MS);
});

// ── Start Monitoring ──
btnStart.addEventListener('click', startMonitoring);

async function startMonitoring() {
  try {
    await audio.acquire();
  } catch {
    return;
  }

  engine.startMonitoring();
  audio.onLevelChange = onAudioFrame;
  audio.startMonitoring();

  circle = new MezzoVoiceCircle(circleContainer, {
    assetPath: 'assets',
    surfaceElement: monCard,
  });

  setTheme('light');
  showScreen('screen-monitor');
}

// ── Audio Frame Handler ──
function onAudioFrame({ rms }) {
  engine.processFrame(rms);
  const state = engine.getCurrentState();
  const nowOutside = state !== LogicalState.IN_RANGE;

  if (nowOutside !== isOutsideRange) {
    isOutsideRange = nowOutside;

    if (nowOutside) {
      sustainedTimer = setTimeout(() => {
        isAlertMode = true;
        stateHeading.textContent = 'Outside Range';
        startBlink(SLOW_BLINK_MS);
        fastBlinkTimer = setTimeout(() => startBlink(FAST_BLINK_MS), FAST_BLINK_AFTER_MS);
        notify('Mezzo', 'Your volume is getting loud — try bringing it down a notch.');
      }, SUSTAINED_ALERT_MS);
    } else {
      stopBlink();
      isAlertMode = false;
      setTheme('light');
      stateHeading.textContent = 'Within Range';
    }
  }

  if (circle) circle.update(rms, baselineRMS, isAlertMode, false);
}

// ── Blink ──
function startBlink(intervalMs) {
  if (blinkInterval) clearInterval(blinkInterval);
  let dark = true;
  blinkInterval = setInterval(() => {
    setTheme(dark ? 'dark' : 'light');
    dark = !dark;
  }, intervalMs);
}

function stopBlink() {
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
  if (fastBlinkTimer) { clearTimeout(fastBlinkTimer); fastBlinkTimer = null; }
  if (sustainedTimer) { clearTimeout(sustainedTimer); sustainedTimer = null; }
}

// ── Theme ──
function setTheme(surface) {
  body.setAttribute('data-surface', surface);
  monCard.setAttribute('data-surface', surface);
}

// ── Stop ──
function stopMonitoring() {
  stopBlink();
  engine.stopMonitoring();
  audio.stopMonitoring();
  audio.release();
  if (circle) { circle.destroy(); circle = null; }
  isOutsideRange = false;
  isAlertMode = false;
  setTheme('light');
  progressBar.style.width = '0%';
  btnCalibrate.disabled = false;
  showScreen('screen-calibrate');
}

btnStop.addEventListener('click', stopMonitoring);
btnRecalibrate.addEventListener('click', () => {
  showScreen('screen-calibrate');
  btnCalibrate.disabled = false;
});

// ── Check mic availability on load ──
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  showScreen('screen-popout');
}

document.getElementById('btn-open-browser').addEventListener('click', () => {
  const url = 'https://mezzo-zoom.onrender.com';
  if (zoomReady) {
    zoomSdk.openUrl({ url }).catch(() => window.open(url, '_blank'));
  } else {
    window.open(url, '_blank');
  }
});

// ── Init ──
initZoom();

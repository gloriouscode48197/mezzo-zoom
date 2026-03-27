/**
 * Audio Processing Module
 *
 * TRUST-CRITICAL: Microphone lifecycle management
 *
 * Core invariant: Browser mic indicator must exactly match app's listening state.
 * - Mic ON only during: calibration capture, active monitoring
 * - Mic OFF during: landing, orientation, confirmation, idle, paused
 *
 * The microphone is acquired fresh for each listening session and fully released
 * when listening ends. We never keep the mic "warm" or "suspended".
 */

// =============================================================================
// Constants
// =============================================================================

const EPSILON = 1e-10;
const EMA_ALPHA = 0.2;
const SAMPLE_INTERVAL_MS = 50;
const FFT_SIZE = 2048;

// =============================================================================
// AudioProcessor Class
// =============================================================================

class AudioProcessor {
  constructor() {
    // Web Audio API objects - all null when mic is released
    this.audioContext = null;
    this.analyser = null;
    this.sourceNode = null;
    this.mediaStream = null;
    this.timeDomainData = null;

    // State flags
    this.isInitialized = false;  // True only while mic is actively acquired
    this.isMonitoring = false;   // True while actively sampling

    // Sampling interval
    this.monitoringInterval = null;

    // Smoothed output values
    this.smoothedRms = 0;
    this.smoothedDb = -100;

    // Calibration reference
    this.noiseFloorDb = -60;

    // External callback
    this.onLevelChange = null;

    // Bind methods
    this.processAudioFrame = this.processAudioFrame.bind(this);
  }

  // ===========================================================================
  // Microphone Lifecycle - TRUST CRITICAL
  // ===========================================================================

  /**
   * Acquire microphone access and set up audio pipeline.
   *
   * MUST be called in direct response to user action.
   * After this returns, the browser mic indicator will be ON.
   */
  async acquire() {
    // Already acquired - no-op
    if (this.isInitialized && this.mediaStream) {
      console.log('[Audio] Microphone already acquired');
      return;
    }

    console.log('[Audio] Acquiring microphone...');

    try {
      // Request microphone - this shows browser permission prompt if needed
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Create AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create analyser node
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;

      // Connect microphone to analyser
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.analyser);

      // Create sample buffer
      this.timeDomainData = new Float32Array(this.analyser.fftSize);

      this.isInitialized = true;
      console.log('[Audio] Microphone acquired - browser indicator should be ON');

    } catch (error) {
      console.error('[Audio] Failed to acquire microphone:', error.message);
      // Ensure clean state on failure
      this.release();
      throw error;
    }
  }

  /**
   * Fully release microphone and all audio resources.
   *
   * After this returns, the browser mic indicator MUST be OFF.
   * This is the ONLY way to turn off the mic indicator.
   */
  release() {
    console.log('[Audio] Releasing microphone...');

    // Stop monitoring interval if running
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;

    // Disconnect source node
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
      this.sourceNode = null;
    }

    // CRITICAL: Stop all tracks - this turns off the browser mic indicator
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => {
        track.stop();
        console.log(`[Audio] Stopped track: ${track.kind}`);
      });
      this.mediaStream = null;
    }

    // Close audio context
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {
        // Ignore close errors
      }
      this.audioContext = null;
    }

    // Clear all references
    this.analyser = null;
    this.timeDomainData = null;
    this.isInitialized = false;
    this.onLevelChange = null;

    // Reset smoothed values
    this.smoothedRms = 0;
    this.smoothedDb = -100;

    console.log('[Audio] Microphone released - browser indicator should be OFF');
  }

  /**
   * Check if microphone is currently acquired (browser indicator ON).
   */
  get isMicrophoneActive() {
    return this.isInitialized && this.mediaStream !== null;
  }

  // ===========================================================================
  // Legacy API - initialize() and destroy() map to acquire() and release()
  // ===========================================================================

  /**
   * @deprecated Use acquire() instead
   */
  async initialize() {
    return this.acquire();
  }

  /**
   * @deprecated Use release() instead
   */
  destroy() {
    return this.release();
  }

  // ===========================================================================
  // Monitoring
  // ===========================================================================

  /**
   * Start continuous audio level monitoring.
   * Microphone must be acquired first.
   */
  startMonitoring() {
    if (!this.isInitialized) {
      console.error('[Audio] Cannot start monitoring: microphone not acquired');
      return;
    }

    if (this.isMonitoring) {
      console.log('[Audio] Already monitoring');
      return;
    }

    console.log('[Audio] Starting monitoring...');
    this.isMonitoring = true;

    // Resume AudioContext if suspended
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }

    // Start sampling interval
    this.monitoringInterval = setInterval(() => {
      this.processAudioFrame();
    }, SAMPLE_INTERVAL_MS);

    console.log('[Audio] Monitoring started');
  }

  /**
   * Stop monitoring (but keep microphone acquired).
   * Use release() to fully release the microphone.
   */
  stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[Audio] Stopping monitoring...');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.isMonitoring = false;
    console.log('[Audio] Monitoring stopped');
  }

  // ===========================================================================
  // Audio Processing
  // ===========================================================================

  processAudioFrame() {
    if (!this.analyser || !this.timeDomainData) return;

    const rms = this.calculateRms();
    const db = Math.max(-120, this.rmsToDb(rms));

    this.smoothedRms = this.applyEmaSmoothing(rms, this.smoothedRms);
    this.smoothedDb = this.applyEmaSmoothing(db, this.smoothedDb);

    if (this.onLevelChange) {
      this.onLevelChange({
        rms: this.smoothedRms,
        db: this.smoothedDb,
        rawRms: rms,
        rawDb: db,
      });
    }
  }

  calculateRms() {
    this.analyser.getFloatTimeDomainData(this.timeDomainData);

    let sumOfSquares = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      const sample = this.timeDomainData[i];
      sumOfSquares += sample * sample;
    }

    return Math.sqrt(sumOfSquares / this.timeDomainData.length);
  }

  rmsToDb(rms) {
    return 20 * Math.log10(rms + EPSILON);
  }

  applyEmaSmoothing(currentValue, previousSmoothedValue) {
    return EMA_ALPHA * currentValue + (1 - EMA_ALPHA) * previousSmoothedValue;
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  getCurrentLevel() {
    return {
      db: this.smoothedDb,
      rms: this.smoothedRms,
    };
  }

  setNoiseFloor(db) {
    this.noiseFloorDb = db;
  }

  getNoiseFloor() {
    return this.noiseFloorDb;
  }

  isSpeaking(delta = 6) {
    return this.smoothedDb > this.noiseFloorDb + delta;
  }

  // ===========================================================================
  // Static Utilities
  // ===========================================================================

  static median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  static percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

export { AudioProcessor, EPSILON, EMA_ALPHA };

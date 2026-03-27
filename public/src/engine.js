/**
 * Mezzo Audio Processing Engine
 *
 * Core logic for detecting when speaking volume exceeds calibrated range.
 * No UI, animations, or browser APIs - just pure state machine logic.
 */

// =============================================================================
// Constants (all configurable)
// =============================================================================

export const FRAME_MS = 25;
export const SPIKE_IGNORE_MS = 250;
export const OUT_OF_RANGE_ENTER_MS = 750;
export const SUSTAINED_ENTER_MS = 500;
export const RETURN_TO_RANGE_MS = 600;
export const THRESHOLD_MULTIPLIER = 1.4;

export const INITIAL_GRACE_MS_MIN = 5000;
export const INITIAL_GRACE_MS_MAX = 8000;

// =============================================================================
// Logical States
// =============================================================================

export const LogicalState = {
  IN_RANGE: 'IN_RANGE',
  OUT_OF_RANGE_SHORT: 'OUT_OF_RANGE_SHORT',
  OUT_OF_RANGE_SUSTAINED: 'OUT_OF_RANGE_SUSTAINED',
};

// =============================================================================
// Engine Class
// =============================================================================

export class MezzoEngine {
  constructor() {
    // Calibration values
    this.baselineRMS = null;
    this.upperThreshold = null;

    // Current state
    this.currentState = LogicalState.IN_RANGE;

    // Lifecycle flags
    this.monitoringActive = false;
    this.calibrationComplete = false;

    // Duration counters (milliseconds)
    this.aboveDurationMs = 0;
    this.belowDurationMs = 0;

    // Grace period
    this.gracePeriodActive = false;
    this.graceRemainingMs = 0;
  }

  // ===========================================================================
  // Calibration
  // ===========================================================================

  /**
   * Calibrate the engine with RMS samples.
   *
   * - Sort samples
   * - Remove lowest 10% and highest 10%
   * - Compute mean of remaining values
   * - Set baselineRMS and upperThreshold
   *
   * @param {number[]} rmsSamples - Array of RMS values from calibration period
   * @throws {Error} If no valid samples exist after trimming
   */
  calibrate(rmsSamples) {
    if (!rmsSamples || rmsSamples.length === 0) {
      throw new Error('Calibration failed: no samples provided');
    }

    // Sort samples ascending
    const sorted = [...rmsSamples].sort((a, b) => a - b);

    // Calculate trim counts (10% from each end)
    const trimCount = Math.floor(sorted.length * 0.1);

    // Trim lowest 10% and highest 10%
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

    if (trimmed.length === 0) {
      throw new Error('Calibration failed: no valid samples after trimming');
    }

    // Compute mean of remaining values
    const sum = trimmed.reduce((acc, val) => acc + val, 0);
    const mean = sum / trimmed.length;

    // Validate: mean must be positive (silence-only would be ~0)
    if (mean <= 0) {
      throw new Error('Calibration failed: samples appear to be silence-only');
    }

    // Set calibration values
    this.baselineRMS = mean;
    this.upperThreshold = mean * THRESHOLD_MULTIPLIER;
    this.calibrationComplete = true;
  }

  // ===========================================================================
  // Monitoring Lifecycle
  // ===========================================================================

  /**
   * Start monitoring.
   *
   * - Must not start unless calibration is complete
   * - Resets all counters
   * - Enters grace period with random duration
   *
   * @throws {Error} If calibration is not complete
   */
  startMonitoring() {
    if (!this.calibrationComplete) {
      throw new Error('Cannot start monitoring: calibration not complete');
    }

    // Reset all counters
    this.aboveDurationMs = 0;
    this.belowDurationMs = 0;

    // Set monitoring state
    this.monitoringActive = true;
    this.currentState = LogicalState.IN_RANGE;

    // Enter grace period with random duration
    this.gracePeriodActive = true;
    this.graceRemainingMs = this._randomBetween(
      INITIAL_GRACE_MS_MIN,
      INITIAL_GRACE_MS_MAX
    );
  }

  /**
   * Stop monitoring.
   *
   * - Immediately stops all processing
   * - Resets all counters and timers
   */
  stopMonitoring() {
    // Reset all counters and timers
    this.aboveDurationMs = 0;
    this.belowDurationMs = 0;
    this.gracePeriodActive = false;
    this.graceRemainingMs = 0;

    // Set monitoring state
    this.monitoringActive = false;
    this.currentState = LogicalState.IN_RANGE;
  }

  // ===========================================================================
  // Frame Processing (Core Loop)
  // ===========================================================================

  /**
   * Process a single audio frame.
   *
   * Called once per FRAME_MS interval with current RMS value.
   *
   * @param {number} rmsValue - Current RMS value from audio processor
   */
  processFrame(rmsValue) {
    if (!this.monitoringActive) {
      return;
    }

    if (this.gracePeriodActive) {
      this.graceRemainingMs -= FRAME_MS;
      this._updateCounters(rmsValue);

      if (this.graceRemainingMs <= 0) {
        this.gracePeriodActive = false;
      }

      return; // No state updates during grace period
    }

    this._updateCounters(rmsValue);
    this._updateState();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get the current logical state.
   *
   * @returns {string} Current LogicalState value
   */
  getCurrentState() {
    return this.currentState;
  }

  /**
   * Check if monitoring is currently active.
   *
   * @returns {boolean}
   */
  isMonitoring() {
    return this.monitoringActive;
  }

  /**
   * Check if calibration has been completed.
   *
   * @returns {boolean}
   */
  isCalibrated() {
    return this.calibrationComplete;
  }

  /**
   * Get calibration values (for debugging/testing).
   *
   * @returns {{ baselineRMS: number|null, upperThreshold: number|null }}
   */
  getCalibrationValues() {
    return {
      baselineRMS: this.baselineRMS,
      upperThreshold: this.upperThreshold,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Update duration counters based on current RMS value.
   *
   * @param {number} rmsValue - Current RMS value
   * @private
   */
  _updateCounters(rmsValue) {
    if (rmsValue > this.upperThreshold) {
      this.aboveDurationMs += FRAME_MS;
      this.belowDurationMs = 0;
    } else {
      this.belowDurationMs += FRAME_MS;
      this.aboveDurationMs = 0;
    }
  }

  /**
   * Update logical state based on duration counters.
   *
   * @private
   */
  _updateState() {
    // Spike rejection: if we have some above-threshold time but it's less
    // than the spike ignore threshold, don't change state yet
    if (this.aboveDurationMs > 0 && this.aboveDurationMs < SPIKE_IGNORE_MS) {
      return;
    }

    // Check for sustained out of range (highest priority)
    if (this.aboveDurationMs >= SUSTAINED_ENTER_MS) {
      this.currentState = LogicalState.OUT_OF_RANGE_SUSTAINED;
      return;
    }

    // Check for short out of range
    if (this.aboveDurationMs >= OUT_OF_RANGE_ENTER_MS) {
      this.currentState = LogicalState.OUT_OF_RANGE_SHORT;
      return;
    }

    // Check for return to range
    if (this.belowDurationMs >= RETURN_TO_RANGE_MS) {
      this.currentState = LogicalState.IN_RANGE;
      return;
    }
  }

  /**
   * Generate random integer between min and max (inclusive).
   *
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number}
   * @private
   */
  _randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

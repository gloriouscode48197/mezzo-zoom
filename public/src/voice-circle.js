/**
 * MezzoVoiceCircle — Self-contained voice visualization component
 *
 * Renders an organic, breathing circle that responds to voice volume.
 * Uses the pre-made SVG brush-stroke assets (4 ring levels × 3 variants × 2 themes).
 *
 * RING STACKING: All 4 ring layers (ring-0 through ring-3) are rendered
 * simultaneously, absolutely positioned on top of each other. Ring-0 is
 * always visible. Higher rings fade in/out as volume crosses thresholds.
 * Each ring layer independently cycles through its 3 SVG variants.
 *
 * Works in both full webpage and PiP windows — scales to fill its container.
 *
 * Usage:
 *   const circle = new MezzoVoiceCircle(containerEl, { assetPath: 'assets' });
 *   // On each audio frame:
 *   circle.update(rms, baseline, isAlert);
 *   // Cleanup:
 *   circle.destroy();
 *
 * Requires: design-tokens/mezzo-tokens.css loaded in the same document.
 */

// =============================================================================
// Constants
// =============================================================================

const VARIANT_COUNT = 3;
const SILENCE_RATIO = 0.3; // Below this fraction of baseline → silence size
const RING_COUNT = 4;

// Ring threshold multipliers on the calibrated baseline RMS.
// Each ring triggers when volume exceeds baseline × multiplier.
export const RING_THRESHOLDS = [1.5, 2.0, 3.0]; // ring-1, ring-2, ring-3

// Staggered cycle durations per ring so layers don't breathe in sync
const VARIANT_CYCLE_MS = [2500, 2800, 2300, 3100];

// Each ring layer's size as a percentage of the stage container.
// Derived from design tokens: within(90) / elevated(160) / sustained(240) / container(280).
const RING_SIZE_PCT = [
  (90 / 280) * 100,   // ring-0: ~32.14%
  (160 / 280) * 100,  // ring-1: ~57.14%
  (240 / 280) * 100,  // ring-2: ~85.71%
  100,                 // ring-3: 100%
];

// =============================================================================
// Component CSS (injected into host document)
// =============================================================================

const COMPONENT_CSS = `
/* ── Voice Circle Container ── */
.mezzo-circle {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
  background: var(--surface);
  transition: background-color var(--transition-reveal);
  overflow: hidden;
}

/* ── Circle Stage (sized + pulsed) ── */
.mezzo-circle-stage {
  width: min(var(--mezzo-size, var(--circle-within)), 90cqmin);
  height: min(var(--mezzo-size, var(--circle-within)), 90cqmin);
  position: relative;
  transition: width var(--transition-reveal), height var(--transition-reveal);
}

/* ── Pulse: Gentle (default — meditative breathing) ── */
.mezzo-circle-stage.pulse-gentle {
  animation: mezzo-pulse-gentle 4s ease-in-out infinite;
}

/* ── Pulse: Alert (faster, more noticeable) ── */
.mezzo-circle-stage.pulse-alert {
  animation: mezzo-pulse-alert 1.8s ease-in-out infinite;
}

/* ── Ring Layer (one per ring level, stacked) ── */
.mezzo-ring-layer {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 350ms ease;
  pointer-events: none;
}

.mezzo-ring-layer.ring-visible {
  opacity: 1;
}

/* ── SVG Images inside each ring layer (crossfade for variant cycling) ── */
.mezzo-ring-img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 1.2s ease;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.mezzo-ring-img.visible {
  opacity: 1;
}

/* ── Keyframes ── */
@keyframes mezzo-pulse-gentle {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}

@keyframes mezzo-pulse-alert {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}

/* ── Fast transitions during alert blink ── */
.mezzo-circle.alert-blink {
  transition: background-color 300ms ease;
}

.mezzo-circle.alert-blink .mezzo-ring-img {
  transition: opacity 300ms ease;
}
`;

// =============================================================================
// MezzoVoiceCircle Class
// =============================================================================

export class MezzoVoiceCircle {
  /**
   * @param {HTMLElement} container — Element to render into (fills 100% of it)
   * @param {Object} [options]
   * @param {string} [options.assetPath='assets'] — Path to the SVG circle assets
   * @param {HTMLElement} [options.surfaceElement] — Element to receive data-surface attr
   *   (defaults to container). Set this to a page-level wrapper if you want
   *   the light/dark theme switch to cascade beyond the circle itself.
   */
  constructor(container, options = {}) {
    this.container = container;
    this.assetPath = options.assetPath ?? 'assets';
    this.surfaceEl = options.surfaceElement || container;

    // ── Visual state ──
    this.currentRingLevel = 0;
    this.currentTheme = 'light';
    this.currentSizeValue = '';
    this.isAlert = false;
    this.isDark = false;

    // ── DOM references ──
    this.el = null;
    this.stage = null;

    /**
     * Each entry: { ring, visible, activeImg, variant, el, imgs[], interval }
     *  - ring:      0-3 (which ring level this layer represents)
     *  - visible:   boolean (is this layer currently shown)
     *  - activeImg: 0 or 1 (which img in the crossfade pair is currently visible)
     *  - variant:   0-2 (current variant in the cycle)
     *  - el:        the wrapper div (.mezzo-ring-layer)
     *  - imgs:      [img0, img1] crossfade pair
     *  - interval:  setInterval id for variant cycling
     */
    this.ringLayers = [];

    // ── Build ──
    this._injectCSS();
    this._createDOM();
    this._startVariantCycles();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Update the visualization with current audio state.
   * Call this on each audio frame (every 25-50 ms). The component
   * only touches the DOM when something actually changes.
   *
   * @param {number} rms      — Current smoothed RMS from AudioProcessor
   * @param {number} baseline — Calibrated baseline RMS (from localStorage / engine)
   * @param {boolean} isAlert — Whether alert mode is active (controls ring stickiness, pulse, size)
   * @param {boolean} isDark  — Whether the dark blink phase is active (controls theme/SVGs)
   */
  update(rms, baseline, isAlert, isDark = false) {
    const newRing = this._computeRingLevel(rms, baseline);
    const newTheme = isDark ? 'dark' : 'light';

    // During alert, ring level can only increase (sticky high).
    // Natural voice fluctuation shouldn't drop rings while alerting.
    const effectiveRing = isAlert
      ? Math.max(newRing, this.currentRingLevel)
      : newRing;

    if (effectiveRing !== this.currentRingLevel) {
      this.currentRingLevel = effectiveRing;
      this._updateRingVisibility();
    }

    // ── Theme changed → crossfade ALL layers to new theme's assets ──
    if (newTheme !== this.currentTheme) {
      this.currentTheme = newTheme;
      this._switchAllLayerThemes();
    }

    // ── Size update ──
    const newSize = this._getSizeValue(effectiveRing, isAlert, rms, baseline);
    if (newSize !== this.currentSizeValue) {
      this.currentSizeValue = newSize;
      this.stage.style.setProperty('--mezzo-size', newSize);
    }

    // ── Alert mode changed → pulse speed + blink transition class ──
    if (isAlert !== this.isAlert) {
      this.isAlert = isAlert;
      this.stage.classList.toggle('pulse-gentle', !isAlert);
      this.stage.classList.toggle('pulse-alert', isAlert);
      this.el.classList.toggle('alert-blink', isAlert);
    }

    // ── Dark state changed → surface theme ──
    if (isDark !== this.isDark) {
      this.isDark = isDark;
      this.surfaceEl.setAttribute('data-surface', isDark ? 'dark' : 'light');
    }
  }

  /**
   * Remove all DOM elements and stop timers.
   */
  destroy() {
    for (const layer of this.ringLayers) {
      if (layer.interval) {
        clearInterval(layer.interval);
        layer.interval = null;
      }
      for (const img of layer.imgs) {
        if (img) img.onload = null;
      }
    }
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }

  // ===========================================================================
  // DOM Setup
  // ===========================================================================

  /** Inject component CSS into the host document (once per document). */
  _injectCSS() {
    const doc = this.container.ownerDocument;
    if (doc.getElementById('mezzo-voice-circle-css')) return;
    const style = doc.createElement('style');
    style.id = 'mezzo-voice-circle-css';
    style.textContent = COMPONENT_CSS;
    doc.head.appendChild(style);
  }

  /** Build the component's DOM tree inside the container. */
  _createDOM() {
    const doc = this.container.ownerDocument;

    // Wrapper (flex-centered, fills container, owns background)
    this.el = doc.createElement('div');
    this.el.className = 'mezzo-circle';

    // Stage (sized by tokens, carries pulse animation)
    this.stage = doc.createElement('div');
    this.stage.className = 'mezzo-circle-stage pulse-gentle';

    // Create 4 ring layers, each with a crossfade pair of images
    for (let ring = 0; ring < RING_COUNT; ring++) {
      const layerEl = doc.createElement('div');
      layerEl.className = 'mezzo-ring-layer';

      // Size each ring layer proportionally
      const pct = RING_SIZE_PCT[ring] + '%';
      layerEl.style.width = pct;
      layerEl.style.height = pct;

      // Ring-0 starts visible; others start hidden
      if (ring === 0) {
        layerEl.classList.add('ring-visible');
      }

      const imgs = [];
      for (let j = 0; j < 2; j++) {
        const img = doc.createElement('img');
        img.className = 'mezzo-ring-img';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.draggable = false;
        imgs.push(img);
        layerEl.appendChild(img);
      }

      // Load initial asset — first image visible, ready for crossfade
      imgs[0].src = this._assetUrl('light', ring, 0);
      imgs[0].classList.add('visible');

      this.ringLayers.push({
        ring,
        visible: ring === 0,
        activeImg: 0,
        variant: 0,
        el: layerEl,
        imgs,
        interval: null,
      });

      this.stage.appendChild(layerEl);
    }

    this.el.appendChild(this.stage);
    this.container.appendChild(this.el);
  }

  // ===========================================================================
  // Asset URL
  // ===========================================================================

  /**
   * Build the SVG asset URL.
   * Pattern: {theme}-bg-circle-ring-{ring}-{variant}.svg
   */
  _assetUrl(theme, ring, variant) {
    return `${this.assetPath}/${theme}-bg-circle-ring-${ring}-${variant}.svg`;
  }

  // ===========================================================================
  // Ring Visibility (additive stacking)
  // ===========================================================================

  /**
   * Show all ring layers up to and including currentRingLevel.
   * Ring-0 is always visible. Higher rings fade in/out via CSS transition.
   */
  _updateRingVisibility() {
    for (let i = 0; i < RING_COUNT; i++) {
      const layer = this.ringLayers[i];
      const shouldBeVisible = i <= this.currentRingLevel;
      if (shouldBeVisible !== layer.visible) {
        layer.visible = shouldBeVisible;
        layer.el.classList.toggle('ring-visible', shouldBeVisible);
      }
    }
  }

  // ===========================================================================
  // Theme Switching
  // ===========================================================================

  /**
   * When the theme changes (light ↔ dark), crossfade every ring layer
   * to the new theme's asset for its current variant.
   */
  _switchAllLayerThemes() {
    for (const layer of this.ringLayers) {
      this._crossfadeLayer(
        layer,
        this._assetUrl(this.currentTheme, layer.ring, layer.variant),
      );
    }
  }

  // ===========================================================================
  // Per-Layer Crossfade
  // ===========================================================================

  /**
   * Crossfade a single ring layer to a new image.
   * Uses onload gating so the transition only begins once the image is ready.
   */
  _crossfadeLayer(layer, src) {
    const nextIdx = 1 - layer.activeImg;
    const nextImg = layer.imgs[nextIdx];
    const prevImg = layer.imgs[layer.activeImg];
    let applied = false;

    const applyTransition = () => {
      if (applied) return;
      applied = true;
      nextImg.classList.add('visible');
      prevImg.classList.remove('visible');
      layer.activeImg = nextIdx;
    };

    nextImg.onload = () => {
      applyTransition();
      nextImg.onload = null;
    };

    nextImg.src = src;

    // If already cached the browser may not fire onload — handle synchronously
    if (nextImg.complete && nextImg.naturalWidth > 0) {
      applyTransition();
      nextImg.onload = null;
    }
  }

  // ===========================================================================
  // Variant Cycling (independent per layer)
  // ===========================================================================

  /**
   * Start variant cycling for each ring layer on staggered timers.
   * Each ring cycles through its 3 brush-stroke variants independently,
   * creating organic, unsynchronized breathing across all visible rings.
   */
  _startVariantCycles() {
    for (let i = 0; i < RING_COUNT; i++) {
      const layer = this.ringLayers[i];
      layer.interval = setInterval(() => {
        layer.variant = (layer.variant + 1) % VARIANT_COUNT;
        this._crossfadeLayer(
          layer,
          this._assetUrl(this.currentTheme, layer.ring, layer.variant),
        );
      }, VARIANT_CYCLE_MS[i]);
    }
  }

  // ===========================================================================
  // Ring Level Computation
  // ===========================================================================

  /**
   * Map current RMS to a ring level (0–3).
   *
   * Uses multiplier thresholds on the calibrated baseline:
   *   ring-1: baseline × 1.5  (50% louder)
   *   ring-2: baseline × 2.0  (double)
   *   ring-3: baseline × 3.0  (triple)
   * Ring 0 = at or below baseline.
   */
  _computeRingLevel(rms, baseline) {
    if (!baseline || baseline <= 0 || !rms || rms <= 0) return 0;
    if (rms <= baseline) return 0;

    if (rms >= baseline * RING_THRESHOLDS[2]) return 3;
    if (rms >= baseline * RING_THRESHOLDS[1]) return 2;
    if (rms >= baseline * RING_THRESHOLDS[0]) return 1;
    return 0;
  }

  // ===========================================================================
  // Size Computation
  // ===========================================================================

  /**
   * Choose the CSS size value based on current state.
   * Uses the design-token custom properties so sizing stays in sync
   * with the rest of the system.
   */
  _getSizeValue(ringLevel, isAlert, rms, baseline) {
    // During alert, stage stays full size — don't shrink on breath pauses
    if (isAlert) {
      return 'var(--circle-container)';
    }

    // Silence: very low volume relative to baseline
    if (!baseline || !rms || rms < baseline * SILENCE_RATIO) {
      return 'var(--circle-silence)';
    }

    // Stage is always full container size — individual ring layers
    // handle their own proportional sizing via RING_SIZE_PCT.
    return 'var(--circle-container)';
  }
}

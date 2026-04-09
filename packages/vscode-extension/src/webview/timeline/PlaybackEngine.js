/**
 * PlaybackEngine.js — owns playback state for the timeline debugger.
 *
 * Lives in the webview. No VS Code API dependencies, no postMessage calls.
 * Instantiated with a TimelineStore-shaped object once the run completes.
 *
 * On every step change callers receive the Step object via callback; they are
 * responsible for updating the UI and sending `step-changed` to the host.
 */

class PlaybackEngine {
  /**
   * @param {{ steps: Array<{ stepId: number, line: number, file: string, functionName?: string }> }} store
   */
  constructor(store) {
    this._steps = (store && Array.isArray(store.steps)) ? store.steps : [];
    this._currentIndex = 0;
    this._timer = null;
    this._intervalMs = 200;
  }

  // ── Read-only accessors ─────────────────────────────────────────────────────

  get currentStepId() {
    if (this._steps.length === 0) return 0;
    return this._steps[this._currentIndex].stepId;
  }

  get currentStep() {
    return this._steps[this._currentIndex] ?? null;
  }

  get stepCount() {
    return this._steps.length;
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  next() {
    if (this._currentIndex < this._steps.length - 1) {
      this._currentIndex++;
    }
    return this.currentStep;
  }

  prev() {
    if (this._currentIndex > 0) {
      this._currentIndex--;
    }
    return this.currentStep;
  }

  /**
   * Jump to the step with the given stepId.
   * Clamps to the first/last step if stepId is out of range.
   * @param {number} stepId
   */
  jumpTo(stepId) {
    if (this._steps.length === 0) return null;
    const idx = this._steps.findIndex(s => s.stepId === stepId);
    if (idx >= 0) {
      this._currentIndex = idx;
    } else {
      // Clamp: below minimum → first, above maximum → last
      const first = this._steps[0].stepId;
      if (stepId <= first) {
        this._currentIndex = 0;
      } else {
        this._currentIndex = this._steps.length - 1;
      }
    }
    return this.currentStep;
  }

  jumpToFirst() {
    this._currentIndex = 0;
    return this.currentStep;
  }

  jumpToLast() {
    this._currentIndex = Math.max(0, this._steps.length - 1);
    return this.currentStep;
  }

  // ── Playback ────────────────────────────────────────────────────────────────

  /**
   * Start auto-play. Calls onStep(step) every ~200ms, advancing one step each
   * tick. Stops automatically at the last step.
   * @param {(step: object) => void} onStep
   */
  play(onStep) {
    if (this._timer !== null) return; // already playing
    if (this._steps.length === 0) return;

    this._timer = setInterval(() => {
      if (this._currentIndex >= this._steps.length - 1) {
        this.pause();
        return;
      }
      this._currentIndex++;
      onStep(this.currentStep);
    }, this._intervalMs);
  }

  pause() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  isPlaying() {
    return this._timer !== null;
  }
}

// Support both browser (<script> tag) and Node.js (smoke test / future tests)
if (typeof window !== 'undefined') {
  window.PlaybackEngine = PlaybackEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlaybackEngine;
}

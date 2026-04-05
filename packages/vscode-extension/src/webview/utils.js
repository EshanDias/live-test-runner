/**
 * utils.js — shared webview utilities.
 *
 * Loaded before testListLayout.js in both explorer.html and results.html.
 * The extension mirror is src/utils/duration.ts — keep the two in sync.
 *
 * Duration thresholds are set by the extension via LiveTestUtils.setThresholds()
 * on the 'init' message. Defaults match DEFAULT_THRESHOLDS in duration.ts.
 *
 * Usage in HTML scripts:
 *   const { durationLabel, durationClass, durationTooltip } = window.LiveTestUtils;
 */

/* eslint-disable no-var */
var _thresholds = {
  test:  [100,  500],
  suite: [500,  2000],
  file:  [1000, 5000],
};

function setThresholds(t) {
  if (t) _thresholds = t;
}

function durationLabel(ms) {
  if (ms == null) return '';
  if (ms < 1000)  return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const parts = [];
  if (hr)                        parts.push(`${hr}h`);
  if (min % 60)                  parts.push(`${min % 60}m`);
  if (sec % 60 || !parts.length) parts.push(`${sec % 60}s`);
  return parts.join(' ');
}

function durationClass(ms, level) {
  if (ms == null) return '';
  const [amber, red] = _thresholds[level] ?? _thresholds.test;
  if (ms > red)   return 'slow';
  if (ms > amber) return 'moderate';
  return 'fast';
}

function durationTooltip(ms, level) {
  if (ms == null) return '';
  const [amber, red] = _thresholds[level] ?? _thresholds.test;
  if (ms > red)   return 'Slow — consider mocking heavy I/O';
  if (ms > amber) return 'Could be improved';
  return 'Fast';
}

window.LiveTestUtils = { setThresholds, durationLabel, durationClass, durationTooltip };

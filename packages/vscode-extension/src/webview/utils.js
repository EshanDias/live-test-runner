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
  const durationMs = Math.round(ms);
  if (durationMs < 1000) return `${durationMs}ms`;
  const sec = Math.floor(durationMs / 1000);
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

/** The copy icon (and the check shown after copying), 14 px, in the button's colour. */
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4H4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V4zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7z"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.3 11.3 2.7 7.7l-.7.7 4.3 4.3 8-8-.7-.7z"/></svg>';

/** A copy button: the icon, a label for screen readers and the tooltip. */
function copyButton(className, title) {
  const btn = document.createElement('button');
  btn.className = `copy-btn ${className}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = COPY_ICON;
  return btn;
}

/** Shows "copied" on a button for a moment (icon buttons: a check; text buttons: "Copied"). */
function showCopied(btn) {
  const before = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = btn.classList.contains('text-btn') ? `${CHECK_ICON}<span>Copied</span>` : CHECK_ICON;
  setTimeout(() => { btn.innerHTML = before; btn.classList.remove('copied'); }, 1200);
}

/** Copies text from the webview (the clipboard is the only place it goes). */
function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => showCopied(btn)).catch(() => {});
}

window.LiveTestUtils = { setThresholds, durationLabel, durationClass, durationTooltip, COPY_ICON, copyButton, copyText, showCopied };

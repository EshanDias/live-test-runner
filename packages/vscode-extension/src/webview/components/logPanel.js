/**
 * logPanel.js — shared log output component.
 *
 * API: { mount(container, payload), update(container, payload), applyFilter(container, level), unmount(container) }
 *
 * `container` is the element that will hold the rendered log lines (e.g. `#logContent`).
 * `payload`   is `{ sections: LogSection[] }` where each section has `.scope`, `.label`,
 *              `.capturedAt`, and `.lines[]` (each line has `.level` and `.text`).
 */

(function () {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _scopeIcon(scope) {
    return { file: '📄', suite: '🔷', test: '🔹' }[scope] ?? '•';
  }

  function _formatCapturedAt(capturedAt) {
    if (capturedAt === null) { return ''; }
    const diff = Date.now() - capturedAt;
    if (diff < 10_000)  { return 'just now'; }
    if (diff < 120_000) { return `${Math.floor(diff / 1000)}s ago`; }
    return new Date(capturedAt).toLocaleTimeString();
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _render(container, sections) {
    container.innerHTML = '';

    if (!sections || sections.length === 0) {
      container.innerHTML = '<div class="empty-state">Select a test to view output</div>';
      return;
    }

    const allEmpty = sections.every(s => s.lines.length === 0);
    if (allEmpty) {
      const scope = sections[0].scope;
      const msg = scope === 'test'
        ? 'No output captured at test level. Run the test individually to capture output here.'
        : scope === 'suite'
        ? 'No output captured at suite level. Check file level for console logs.'
        : 'No output captured yet. Run a test to see logs here.';
      container.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    for (const section of sections) {
      if (section.lines.length === 0) { continue; }

      const sectionEl = document.createElement('div');
      sectionEl.className = 'output-section';
      sectionEl.dataset.scope = section.scope;

      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML =
        `<span class="scope-icon">${_scopeIcon(section.scope)}</span>` +
        `<span class="scope-label">${_escHtml(section.label)}</span>` +
        `<span class="captured-at">${_formatCapturedAt(section.capturedAt)}</span>`;
      sectionEl.appendChild(header);

      const linesEl = document.createElement('div');
      linesEl.className = 'section-lines';
      for (const line of section.lines) {
        const lineEl = document.createElement('div');
        lineEl.className = `log-line log-line-${line.level}`;
        lineEl.dataset.level = line.level;
        lineEl.textContent = line.text;
        linesEl.appendChild(lineEl);
      }
      sectionEl.appendChild(linesEl);
      container.appendChild(sectionEl);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  const LogPanel = {

    mount(container, payload) {
      _render(container, payload && payload.sections);
    },

    update(container, payload) {
      _render(container, payload && payload.sections);
    },

    /**
     * Show/hide log lines by level. Call after mount/update whenever the active
     * tab changes. `level` is 'all' | 'log' | 'info' | 'warn' | 'error'.
     */
    applyFilter(container, level) {
      container.querySelectorAll('.log-line').forEach(el => {
        el.style.display = (level === 'all' || el.dataset.level === level) ? '' : 'none';
      });
      container.querySelectorAll('.output-section').forEach(section => {
        const hasVisible = [...section.querySelectorAll('.log-line')]
          .some(el => el.style.display !== 'none');
        section.style.display = hasVisible ? '' : 'none';
      });
    },

    unmount(container) {
      container.innerHTML = '';
    },
  };

  window.LogPanel = LogPanel;
})();

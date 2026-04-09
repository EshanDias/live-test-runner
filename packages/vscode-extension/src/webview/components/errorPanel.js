/**
 * errorPanel.js — shared error/failure output component.
 *
 * API: { mount(container, payload), update(container, payload), unmount(container) }
 *
 * `container` is the element that will hold the rendered errors (e.g. `#errorContent`).
 * `payload`   is `{ sections: ErrorSection[] }` where each section has `.errors[]`,
 *              each error having `.testName` and `.failureMessages[]`.
 */

(function () {

  function _render(container, sections) {
    container.innerHTML = '';

    if (!sections || sections.length === 0 || sections.every(s => s.errors.length === 0)) {
      container.innerHTML = '<div class="empty-state no-errors">No failures for this selection ✓</div>';
      return;
    }

    for (const section of sections) {
      for (const entry of section.errors) {
        const entryEl = document.createElement('div');
        entryEl.className = 'error-entry';

        const nameEl = document.createElement('div');
        nameEl.className = 'error-test-name';
        nameEl.textContent = entry.testName;
        entryEl.appendChild(nameEl);

        for (const msg of entry.failureMessages) {
          const msgEl = document.createElement('pre');
          msgEl.className = 'error-message';
          msgEl.textContent = msg;
          entryEl.appendChild(msgEl);
        }

        container.appendChild(entryEl);
      }
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  const ErrorPanel = {

    mount(container, payload) {
      _render(container, payload && payload.sections);
    },

    update(container, payload) {
      _render(container, payload && payload.sections);
    },

    unmount(container) {
      container.innerHTML = '';
    },
  };

  window.ErrorPanel = ErrorPanel;
})();

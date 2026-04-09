/**
 * timelineView.js — timeline debugger view for ResultsView (results.html).
 *
 * Stub only. Full implementation arrives in tasks 11+.
 * Responds to { type: 'route', view: 'timeline' } from the extension host.
 */

(function () {
  const TimelineView = {
    mount(container, vscode, payload) {
      container.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center;
                    height:100%; color:var(--vscode-foreground); font-size:13px; opacity:0.6;">
          <p>Timeline view — coming soon</p>
        </div>`;
    },

    unmount() {},

    onMessage(_msg) {},
  };

  window.TimelineView = TimelineView;
})();

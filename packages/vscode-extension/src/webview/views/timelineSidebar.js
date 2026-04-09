/**
 * timelineSidebar.js — timeline debugger sidebar view for ExplorerView (explorer.html).
 *
 * Stub only. Full implementation arrives in task 12.
 * Responds to { type: 'route', view: 'timelineSidebar' } from the extension host.
 */

(function () {
  const TimelineSidebar = {
    mount(container, vscode, payload) {
      container.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center;
                    height:100%; color:var(--vscode-foreground); font-size:13px; opacity:0.6;">
          <p>Timeline sidebar — coming soon</p>
        </div>`;
    },

    unmount() {},

    onMessage(_msg) {},
  };

  window.TimelineSidebar = TimelineSidebar;
})();

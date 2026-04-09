/**
 * router.js — shared single-page router for ResultsView and ExplorerView webviews.
 *
 * Exposes window.Router. Usage in the HTML shell:
 *
 *   Router.init({
 *     vscode,
 *     views: { results: ResultsView, timeline: TimelineView },
 *     defaultView: 'results',
 *   });
 *
 * Each view object must implement:
 *   mount(container, vscode, payload)  — render into container
 *   unmount()                          — clean up (router clears innerHTML after)
 *   onMessage(msg)                     — handle extension-host messages
 *
 * The router intercepts { type: 'route', view, payload } messages and swaps
 * views. All other messages are forwarded to the currently active view.
 */

(function () {
  const Router = {
    _views: {},
    _current: null,
    _vscode: null,

    /**
     * @param {{ vscode: object, views: Record<string, object>, defaultView?: string }} opts
     */
    init({ vscode, views, defaultView }) {
      this._vscode = vscode;
      this._views  = views;

      window.addEventListener('message', ({ data }) => {
        if (data.type === 'route') {
          this.go(data.view, data.payload);
        } else if (this._current && typeof this._current.onMessage === 'function') {
          this._current.onMessage(data);
        }
      });

      if (defaultView) {
        this.go(defaultView);
      }
    },

    /**
     * Switch to a named view, passing an optional payload to its mount().
     * @param {string} viewName
     * @param {object} [payload]
     */
    go(viewName, payload) {
      // Unmount current view
      if (this._current && typeof this._current.unmount === 'function') {
        this._current.unmount();
      }

      const app = document.getElementById('app');
      if (!app) { return; }
      app.innerHTML = '';

      const view = this._views[viewName];
      if (!view) {
        app.innerHTML = `<div style="padding:16px;color:var(--vscode-errorForeground)">Unknown view: ${viewName}</div>`;
        this._current = null;
        return;
      }

      this._current = view;
      view.mount(app, this._vscode, payload ?? {});
    },
  };

  window.Router = Router;
})();

/**
 * The few `vscode` APIs that store / coverage modules touch when they are
 * loaded in a unit test (mapped in jest.config.js). Anything editor-facing is
 * covered by the e2e suite instead.
 */
export class EventEmitter<T> {
  private readonly _listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners.splice(this._listeners.indexOf(listener), 1); } };
  };
  fire(e: T): void { for (const l of [...this._listeners]) { l(e); } }
  dispose(): void { this._listeners.length = 0; }
}

export enum LogLevel { Off = 0, Trace = 1, Debug = 2, Info = 3, Warning = 4, Error = 5 }

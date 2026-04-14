// @ts-nocheck
export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  })),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn(),
    update: jest.fn(),
  })),
};

export const commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn(),
};

export const Range = jest.fn();
export const Position = jest.fn();
export const Uri = {
  file: jest.fn((path) => ({ fsPath: path })),
  parse: jest.fn((val) => ({ toString: () => val })),
};

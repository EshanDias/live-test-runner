# Session instrumentation — shared

Framework-neutral code that runs inside the test process (`sessionTraceRuntime.js`, the
`__strace` runtime) or is shared by every framework's discovery (`testDiscovery.js`).
Framework-specific pieces (transform, setup file, reporter) live next to this folder, one folder
per framework (`../jest/`).

The contract between them — `__strace` API, trace/coverage/result record formats, environment
variables — is documented in `docs/architecture.md` → *Session instrumentation protocol*.

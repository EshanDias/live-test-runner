# Instructions

1. Read all bugs first, if there are any which relates we can combine and do them.
2. When a bug is complete, tell how to verify it and ask user to verify and and update the bug list. remove fixed bugs. 
3. Ask to continue with the next/current bug after a bug is completed or at the end of a discussion done towards a bug.
4. Project related docs are in /Users/eshandias/Projects/Personal/live-test-runner/docs. temp_plans subfolder has any current developments we are working on
5. Keep reasoning minimal. Provide only essential explanation.

# Bugs

1. ~~removePendingPlaceholders works fine but the summary in explorer doesn't work.~~ **FIXED** — Discovery sends `testTotal` from `getSummary()` so the summary shows the live store count as files are discovered. When tests run, `removePendingPlaceholders` cleans the store before `onFileResult` fires, so `full-file-result` and `run-finished` naturally deliver the corrected count.
2. Log scopedOutput not working. I assumed this will work with AST. - your response was: "You're not wrong at all — you're actually right. The trace runtime already tracks _currentTestName via enterTest/exitTest. We can patch console.log/warn/error/info inside sessionTraceRuntime.js to emit LOG events attributed to the active test. Then SessionTraceRunner reads those from the .jsonl and stores them as test-level output. That gives true per-test console scoping from the trace run.That's a solid follow-on for the issue"
3. Observer/Subscriber architectural refactor — The extension host already has IResultObserver / SessionManager._notify, which is the right pattern at the host level. What's missing is a reactive layer *inside the webviews* so they automatically sync from the store rather than the host explicitly pushing every message type. This is a significant refactor: would need a centralized event bus in the host that maps store mutations → specific postMessage types, and each webview subscribing to only the events it cares about. Defer until a dedicated session.
4. Live test results cache is not cleared at vs code close. or a project folder close How do we clear cache otherwise we will be adding on so much temporary files. Is it worth having a feature to save sessions, load sessions. At least just the last run? Just thinking of large projects with thousands of test cases. or a poorly written project where tests run over 10 minutes. If we load session we do need to write the in memory store as well.

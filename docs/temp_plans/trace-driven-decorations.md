# Plan: Trace-Driven Line Decorations

## Goal

Decorate every line that actually executed with the correct colour, not just the
statement definition line. Use the execution trace as the primary source for
green lines. Use the coverage manifest + counters for red, amber, and grey —
exactly as today.

---

## Background

Currently `CoverageDecorationManager` classifies lines using only the coverage
manifest and Istanbul counters from `CoverageStore`. A statement spanning lines
5–9 gets a green bar on line 5 only, even though lines 6–9 also executed. The
trace store already records every physical line that fired a `__strace.step()`
call, so the data needed for multi-line decoration exists — it just isn't being
used for decorations.

---

## Colour Logic (new)

| Colour | Condition |
|--------|-----------|
| **Green** | Line is in `traceStore.getCoveredLines()` AND no missed branch arms |
| **Amber** | Line is in `traceStore.getCoveredLines()` AND manifest has branch(es) on this line with at least one arm at 0 hits |
| **Red** | Line is in the manifest (executable) but NOT in `traceStore.getCoveredLines()` |
| **Grey** | Line is in neither the manifest nor the trace (blank, comment, brace) |

The manifest remains the authority on what is executable.
The trace is the deciding factor for green vs red.

---

## Fallback

If `traceStore.getCoveredLines(filePath)` returns an empty set, fall back to
the current behaviour — classify using Istanbul counters from `CoverageStore`
only (statement definition line, no multi-line expansion). This covers the rare
case where the trace file was not produced.

---

## Changes Required

### 1. `CoverageDecorationManager.ts`

- Inject `ExecutionTraceStore` via constructor (alongside existing `CoverageStore`)
- In `_refreshEditor()`, fetch `traceLines = traceStore.getCoveredLines(filePath)`
- Pass `traceLines` into `_classifyLines()`
- In `_classifyLines()`:
  - If `traceLines.size > 0` → use trace-driven path
  - Else → use existing Istanbul counter path (unchanged)
- Trace-driven classification:
  - Iterate manifest statements to build the set of executable lines (same as today)
  - For each executable line: green/amber if in `traceLines`, red if not
  - Branch partial logic unchanged — still reads from `counters.b`
  - Non-executable lines → grey (unchanged)

### 2. `extension.ts`

- Pass `ExecutionTraceStore` into `CoverageDecorationManager` constructor

---

## What Does NOT Change

- `CoverageStore` — untouched
- `ExecutionTraceStore` — untouched
- Coverage percentage calculations — untouched, decorations are purely visual
- Amber and red logic — same manifest + counters source as today
- Grey logic — same as today
- Hover provider — untouched
- The fallback path in `_classifyLines` — identical to current code

---

## Scope

| File | Change |
|------|--------|
| `src/editor/CoverageDecorationManager.ts` | Constructor + `_classifyLines` |
| `src/extension.ts` | Pass `ExecutionTraceStore` to constructor |

Two files. The core logic change is entirely inside `_classifyLines`.

---

## Risk

Low. The fallback guarantees existing behaviour is preserved when trace data is
absent. The coverage calculations and all other systems are untouched.

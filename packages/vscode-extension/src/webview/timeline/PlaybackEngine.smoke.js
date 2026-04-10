/**
 * PlaybackEngine smoke test.
 * Run with: node src/webview/timeline/PlaybackEngine.smoke.js
 */

const PlaybackEngine = require('./PlaybackEngine');

const store = {
  steps: [
    { stepId: 1, line: 10, file: 'calc.test.js', functionName: 'calcTest' },
    { stepId: 2, line: 11, file: 'calc.test.js', functionName: 'calcTest' },
    { stepId: 3, line: 12, file: 'calc.test.js', functionName: 'calcTest' },
  ],
};

const engine = new PlaybackEngine(store);

// Initial state
console.assert(engine.currentStepId === 1,      'starts at first step');
console.assert(engine.stepCount     === 3,      'stepCount correct');
console.assert(!engine.isPlaying(),             'not playing on creation');

// Navigation
engine.next();
console.assert(engine.currentStepId === 2,      'next() moves forward');

engine.prev();
console.assert(engine.currentStepId === 1,      'prev() moves back');

engine.prev(); // already at first — should clamp
console.assert(engine.currentStepId === 1,      'prev() clamps at first step');

// jumpTo
engine.jumpTo(3);
console.assert(engine.currentStepId === 3,      'jumpTo(3) works');

engine.jumpTo(-99);
console.assert(engine.currentStepId === 1,      'jumpTo clamps to first step');

engine.jumpTo(9999);
console.assert(engine.currentStepId === 3,      'jumpTo clamps to last step');

// jumpToFirst / jumpToLast
engine.jumpToFirst();
console.assert(engine.currentStepId === 1,      'jumpToFirst()');
engine.jumpToLast();
console.assert(engine.currentStepId === 3,      'jumpToLast()');

// play / pause
engine.jumpToFirst();
const seen = [];
engine.play((step) => seen.push(step.stepId));
console.assert(engine.isPlaying(),              'isPlaying() true after play()');

setTimeout(() => {
  engine.pause();
  console.assert(!engine.isPlaying(),           'isPlaying() false after pause()');
  console.assert(seen.length > 0,              'onStep called at least once during play');
  console.assert(seen.every(id => id >= 1 && id <= 3), 'all stepIds in valid range');

  // play stops at last step automatically
  engine.jumpToLast();
  const after = [];
  engine.play((step) => after.push(step.stepId));
  setTimeout(() => {
    console.assert(!engine.isPlaying(),         'play stops automatically at last step');
    console.log('All smoke tests passed ✓');
  }, 400);
}, 700);

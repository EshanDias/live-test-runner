// Used only by setupTests.js hooks.
let state = { dirty: false };

function resetState() {
  state = { dirty: false };
}

function markDirty() {
  state.dirty = true;
}

module.exports = { resetState, markDirty };

// Branch-heavy code, partly tested (branches.test): every construct a coverage tool counts.
function classify(n, opts = {}) {
  if (n < 0) {
    return "negative";
  } else if (n === 0) {
    return "zero";
  }
  const label = n > 100 ? "big" : "small";
  const unit = opts.unit || "items";
  const sep = opts.sep ?? " ";
  return label + sep + unit;
}

function pick(obj) {
  return obj?.a?.b ?? (obj && obj.c);
}

function sw(kind) {
  switch (kind) {
    case "a":
      return 1;
    case "b":
      return 2;
    default:
      return 0;
  }
}

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return "failed";
  }
}

const twice = (x) => x * 2;
const never = (x) => (x ? x : -x);

class Box {
  constructor(v) {
    this.v = v;
  }
  get() {
    return this.v;
  }
  unused() {
    return this.v + 1;
  }
}

async function later(x) {
  if (!x) return null;
  return x;
}

let mode = "dev";
if (typeof process !== "undefined" && process.env.LTR_NEVER_SET) {
  mode = "never";
}

module.exports = { classify, pick, sw, safe, twice, never, Box, later, mode };

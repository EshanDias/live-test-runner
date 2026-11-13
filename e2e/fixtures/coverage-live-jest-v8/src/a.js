const { helper } = require('./b');

function one(x) {
  return helper(x);
}

function two(x) {
  return x * 2;
}

module.exports = { one, two };

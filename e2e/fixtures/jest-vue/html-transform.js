// A project's own Jest transformer for .html templates (as jest-preset-angular has).
module.exports = {
  process(src) {
    return { code: `module.exports = ${JSON.stringify(src)};` };
  },
};

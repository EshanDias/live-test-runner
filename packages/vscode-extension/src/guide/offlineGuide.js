'use strict';
/**
 * Build step (esbuild.js → copyGuide): turns the published guide
 * (docs/live-test-runner-guide.html) into the copy that ships in the
 * extension, which must load nothing from the network.
 *
 * - Each remote picture becomes a short note with a link to the same section
 *   of the online guide (opened only when the user clicks it). The pictures
 *   stay in the online guide; the .vsix stays small.
 * - `<link rel="canonical">` (metadata for the published page) is dropped.
 * - Anything else that would load a remote resource by itself (scripts,
 *   stylesheets, frames, media, CSS url() / @import) fails the build, so a new
 *   one is a decision, not an accident.
 */

/** The guide published with GitHub Pages (GuidePanel.ts has the same URL; a unit test keeps them equal). */
const GUIDE_URL = 'https://eshandias.github.io/live-test-runner/guide/';

const REMOTE = /^(?:https?:)?\/\//i;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
};
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const NOTE_CSS = '<style>.offline-media{border:1px dashed currentColor;border-radius:8px;padding:8px 12px;opacity:.8;font-size:.95em}</style>';

/**
 * @param {string} html the published guide
 * @param {string} [onlineUrl] where the full guide (with pictures) lives
 * @returns {string} the guide to ship
 */
function offlineGuide(html, onlineUrl = GUIDE_URL) {
  // Section ids, to link each note to the same place in the online guide.
  const sections = [...html.matchAll(/<section\b[^>]*\sid="([^"]+)"/gi)].map((m) => ({ at: m.index, id: m[1] }));
  const sectionAt = (i) => sections.filter((s) => s.at < i).pop()?.id;

  let out = html.replace(/<img\b[^>]*>/gi, (tag, at) => {
    const src = attr(tag, 'src') || '';
    if (!REMOTE.test(src)) { return tag; }
    const alt = unescapeHtml(attr(tag, 'alt') || 'a picture');
    const id = sectionAt(at);
    const href = `${onlineUrl}${id ? `#${id}` : ''}`;
    return `<p class="offline-media">Picture: ${escapeHtml(alt)}. <a href="${escapeHtml(href)}" target="_blank" rel="noopener">See it in the online guide</a>.</p>`;
  });
  out = out.replace(/[ \t]*<link\b[^>]*\srel\s*=\s*["']?canonical["']?[^>]*>\r?\n?/gi, '');

  const problems = remoteResources(out);
  if (problems.length) {
    throw new Error(`the shipped guide would load remote resources:\n  ${problems.join('\n  ')}`);
  }
  return out.replace(/<\/head>/i, `${NOTE_CSS}\n</head>`);
}

/**
 * Everything in `html` that a browser would fetch from another origin by
 * itself (no click): src / poster / data on media and frames, stylesheets and
 * other <link> preloads, <object>, CSS url() and @import, <meta http-equiv="refresh">.
 * Plain <a href> links are not listed: they load only when clicked.
 */
function remoteResources(html) {
  const found = [];
  for (const m of html.matchAll(/<(img|script|iframe|frame|video|audio|source|track|embed|object|input|link|image|use)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    for (const a of ['src', 'srcset', 'poster', 'data', 'href', 'xlink:href']) {
      if (a === 'href' && !['link', 'image', 'use'].includes(name)) { continue; }
      const v = attr(tag, a.replace(':', '\\:'));
      if (v && v.split(',').some((part) => REMOTE.test(part.trim()))) { found.push(tag.slice(0, 160)); }
    }
  }
  for (const m of html.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi)) { found.push(`url(${m[1]})`); }
  for (const m of html.matchAll(/@import\s+(?:url\()?\s*['"]?((?:https?:)?\/\/[^'")\s;]+)/gi)) { found.push(`@import ${m[1]}`); }
  for (const m of html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi)) { found.push(m[0]); }
  return found;
}

module.exports = { offlineGuide, remoteResources, GUIDE_URL };

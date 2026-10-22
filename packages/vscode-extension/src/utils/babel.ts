/**
 * Babel for the extension's own source analysis (coverage source scan):
 * the project's @babel/parser / @babel/traverse when it has them — every
 * Jest project does, and the counts then match its own tooling — otherwise
 * the parser shipped in out/vendor (see esbuild.js) and a minimal walker.
 * Vitest projects usually have no Babel.
 */
import * as path from 'path';

export type BabelParser = { parse(code: string, options: Record<string, unknown>): any };
/** A visitor called as `visitors[node.type]({ node, parent, parentKey })`, depth first, parents first. */
export type Traverse = (ast: any, visitors: Record<string, (p: { node: any; parent: any; parentKey: string | undefined }) => void>) => void;

function fromProject<T>(id: string, projectRoot: string): T | undefined {
  try { return require(require.resolve(id, { paths: [projectRoot] })) as T; } catch { return undefined; }
}

/** The project's @babel/parser, else the extension's own copy (undefined only if both are missing). */
export function loadBabelParser(projectRoot: string): BabelParser | undefined {
  const own = fromProject<BabelParser>('@babel/parser', projectRoot);
  if (own) { return own; }
  for (const file of [path.join(__dirname, 'vendor', 'babel-parser.js')]) {
    try { return require(file) as BabelParser; } catch { /* next */ }
  }
  try { return require(require.resolve('@babel/parser', { paths: [__dirname] })) as BabelParser; } catch { return undefined; }
}

/** The project's @babel/traverse, else {@link walk}. */
export function loadTraverse(projectRoot: string): Traverse {
  let t = fromProject<any>('@babel/traverse', projectRoot);
  if (t?.default) { t = t.default; }
  return typeof t === 'function' ? t : walk;
}

/** AST keys that hold no child nodes worth visiting. */
const SKIP = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

/** The part of @babel/traverse the source scan uses: type visitors with node, parent and parentKey. */
export const walk: Traverse = (ast, visitors) => {
  const visit = (node: any, parent: any, parentKey: string | undefined) => {
    if (!node || typeof node.type !== 'string') { return; }
    visitors[node.type]?.({ node, parent, parentKey });
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) { continue; }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) { if (c && typeof c === 'object') { visit(c, node, key); } }
      } else if (child && typeof child === 'object') {
        visit(child, node, key);
      }
    }
  };
  visit(ast.program ?? ast, undefined, undefined);
};

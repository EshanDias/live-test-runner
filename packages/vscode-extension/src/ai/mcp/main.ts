/**
 * Entry of out/mcp.js — the MCP relay process (see server.ts). Started by an
 * agent, through the launcher in the extension's storage folder (launcher.ts)
 * or by Cursor's registration with the window's session folder.
 */
import { runStdio } from './server';

declare const LTR_VERSION: string;

runStdio(typeof LTR_VERSION === 'string' ? LTR_VERSION : '0.0.0');

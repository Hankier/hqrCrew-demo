// Which CLI runs an agent: Claude Code (`claude -p`, claude.js) or OpenAI Codex CLI (`codex exec`, codex.js).
// crew.json picks one for every role ("engine": "codex") or per role ("engine": { "coder": "codex" }).
// Both return the same result shape, so the lead and the runner don't care which one ran.
import { runClaude } from './claude.js';
import { runCodex } from './codex.js';

export const ROLES = ['lead', 'designer', 'coder', 'verifier'];
export const ENGINES = ['claude', 'codex'];
export const ENGINE_NAMES = { claude: 'Claude Code', codex: 'Codex' };

export function engineFor(cfg, role) {
  const e = (typeof cfg.engine === 'string' ? cfg.engine : cfg.engine?.[role]) || 'claude';
  if (!ENGINES.includes(e)) throw new Error(`Unknown engine "${e}" for the ${role}; use claude or codex`);
  return e;
}

export const engineName = (engine) => ENGINE_NAMES[engine] || engine;

// The per-role options of the chosen CLI: binary, model, effort, and Codex's sandbox settings.
export function agentFor(cfg, role) {
  const engine = engineFor(cfg, role);
  const effort = cfg.effort?.[role];
  if (engine === 'codex') {
    const cx = cfg.codex || {};
    const net = typeof cx.network === 'object' && cx.network ? cx.network[role] : cx.network;
    return { engine, role, bin: cx.bin || 'codex', model: cx.models?.[role] || null, effort, sandbox: cx.sandbox?.[role] || null, network: !!net, codexConfig: cx.config || {} };
  }
  return { engine, role, bin: cfg.claude?.bin || 'claude', model: cfg.models?.[role], effort };
}

// o.stopHook = { command, timeout }: a command that may block the agent from stopping
// (prints {"decision":"block","reason":…}). Both CLIs run it the same way.
export function runAgent(o) {
  if (o.engine === 'codex') return runCodex(o);
  return runClaude(claudeOptions(o)).then((r) => ({ engine: 'claude', ...r }));
}

// Claude Code takes the Stop hook through --settings.
export function claudeOptions(o) {
  const x = { ...o };
  if (o.stopHook) {
    const stop = [{ hooks: [{ type: 'command', command: o.stopHook.command, timeout: o.stopHook.timeout || 600 }] }];
    x.settings = { ...(o.settings || {}), hooks: { ...(o.settings?.hooks || {}), Stop: stop } };
  }
  return x;
}

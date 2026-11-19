// crew init: create CREW_HOME with a config, one project, its vision and the lead's working folder.
import fs from 'node:fs';
import path from 'node:path';
import { readText, writeFileAtomic, fill } from './util.js';
import { leadInstructions } from './lead.js';

// template: node or python (templates/project.<template>.json); default: the project's own, else generic.
export function init({ home, root, project = 'app', prefix, name, template, out }) {
  const tdir = path.join(root, 'templates');
  const made = [];
  const put = (rel, text) => {
    const f = path.join(home, rel);
    if (fs.existsSync(f)) return;
    writeFileAtomic(f, text);
    made.push(rel);
  };

  put('crew.json', readText(path.join(tdir, 'crew.json')));
  const kind = template || project;
  const specific = path.join(tdir, `project.${kind}.json`);
  if (template && !fs.existsSync(specific)) throw new Error(`No template ${template}; try node or python`);
  const projectTemplate = fs.existsSync(specific) ? readText(specific) : readText(path.join(tdir, 'project.json'));
  const vars = { key: project, prefix: (prefix || project.slice(0, 2)).toUpperCase(), name: name || project };
  put(`projects/${project}/project.json`, fill(projectTemplate, vars));
  const vision = path.join(tdir, `vision.${kind}.md`);
  put(`projects/${project}/vision.md`, fill(readText(fs.existsSync(vision) ? vision : path.join(tdir, 'vision.md')), vars));
  const envTpl = path.join(tdir, `agent.env.${kind}.example`);
  put(`projects/${project}/agent.env`, readText(fs.existsSync(envTpl) ? envTpl : path.join(tdir, 'agent.env.example')));
  const scrub = path.join(tdir, `scrub.${kind}.sql`);
  if (fs.existsSync(scrub)) put(`projects/${project}/scrub.sql`, readText(scrub));
  // Project notes appended to the designer's, coder's and verifier's prompts (migrations, memory limits, language…).
  for (const role of ['coder', 'verifier', 'designer']) {
    const notes = path.join(tdir, `${role}.${kind}.md`);
    if (fs.existsSync(notes)) put(`projects/${project}/${role}.md`, readText(notes));
  }
  // The lead's instructions: CLAUDE.md for Claude Code, AGENTS.md for Codex (same text).
  put('orchestrator/CLAUDE.md', leadInstructions(home));
  put('orchestrator/AGENTS.md', leadInstructions(home));
  for (const d of ['tickets', 'worktrees', 'mirrors', 'logs']) fs.mkdirSync(path.join(home, d), { recursive: true });
  try {
    fs.chmodSync(path.join(home, 'projects', project, 'agent.env'), 0o600);
  } catch {}

  out(made.length ? `Created in ${home}:\n  ${made.join('\n  ')}` : `${home} already set up; nothing changed.`);
  out(`Next: edit ${path.join(home, 'projects', project, 'project.json')} (repo, gate, preview), then run \`crew doctor\`.`);
}

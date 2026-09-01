/**
 * Two things about the node installer that are easy to break and silent when
 * broken, checked against the files themselves.
 *
 * Prints one line per problem and exits non-zero if there were any.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = readFileSync(path.join(repo, 'scripts/install-node.sh'), 'utf8');
const problems = [];

/* The agent.env the installer writes onto a node. A variable that is never
   assigned is not an error in a heredoc: it writes an empty value into a
   production configuration, and the agent then fails later, somewhere else,
   for a reason that does not mention this. */
const lines = installer.split('\n');
const start = lines.findIndex((line) => line.startsWith('cat > "${CONFIG_DIR}/agent.env"'));
const end = lines.findIndex((line, index) => index > start && line.trim() === 'CONFIG');

if (start === -1 || end === -1) {
  problems.push('install-node.sh no longer writes an agent.env the way this check expects');
} else {
  const written = lines.slice(start + 1, end).join('\n');
  const referenced = new Set([...written.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]));
  const before = lines.slice(0, start).join('\n');
  const assigned = new Set(
    [
      ...before.matchAll(
        /^\s*(?:readonly\s+|declare\s+-\w+\s+|export\s+|local\s+)?([A-Z_][A-Z0-9_]*)=/gm,
      ),
    ].map((m) => m[1]),
  );

  for (const name of [...referenced].sort()) {
    if (!assigned.has(name)) problems.push(`agent.env writes \${${name}}, which nothing sets`);
  }
}

/* What the agent refuses to start without, against what the installer writes.
   A field added to the schema without a default strands every node installed
   by an older script. */
const schema = readFileSync(path.join(repo, 'packages/config/src/env.ts'), 'utf8');
const block = /agentEnvSchema\s*=\s*z\.object\(\{([\s\S]*?)^\}\)/m.exec(schema);

if (!block) {
  problems.push('could not find agentEnvSchema in packages/config/src/env.ts');
} else {
  const required = [...block[1].matchAll(/^\s+([A-Z_][A-Z0-9_]*):\s*(.+?),?$/gm)]
    .filter(([, , rule]) => !rule.includes('.default(') && !rule.includes('.optional()'))
    .map(([, name]) => name);
  const producedByInstaller = new Set(
    [...installer.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );

  for (const name of required) {
    if (!producedByInstaller.has(name)) {
      problems.push(`the agent requires ${name} and the installer never writes it`);
    }
  }
}

for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);

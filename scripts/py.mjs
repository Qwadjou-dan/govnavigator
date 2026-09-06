#!/usr/bin/env node
/**
 * Run the backend virtualenv's Python, whatever the platform.
 *
 * The npm scripts used to hardcode `.venv\Scripts\python.exe`, which is the
 * Windows layout. On macOS and Linux the interpreter lives at `.venv/bin/python`,
 * so every backend script failed for anyone not on Windows. This resolves the
 * right path at run time instead of baking one OS into package.json.
 *
 * Usage:  node scripts/py.mjs -m app.scripts.seed --reset
 * Args are passed straight through, and the process runs with cwd=backend so
 * that `-m app.…` resolves the package the same way it does for a human who
 * cd'd into backend themselves.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backend = join(root, 'backend');
const isWindows = process.platform === 'win32';
const python = join(
  backend,
  '.venv',
  isWindows ? 'Scripts' : 'bin',
  isWindows ? 'python.exe' : 'python',
);

if (!existsSync(python)) {
  console.error(
    `No backend virtualenv found at:\n  ${python}\n\n` +
      `Create it first:\n  npm run setup:backend\n`,
  );
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), {
  cwd: backend,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start Python: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

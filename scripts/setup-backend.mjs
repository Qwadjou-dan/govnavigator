#!/usr/bin/env node
/**
 * Create the backend virtualenv, install dependencies, and make a .env.
 *
 * Cross-platform replacement for the old Windows-only shell one-liner, which
 * used `if not exist … copy …` and backslash paths. Deliberately does NOT seed
 * the database: seeding needs a real DATABASE_URL and network access to it, and
 * failing that step should not make it look like dependency installation failed.
 * Run `npm run seed` separately once .env points at a database.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backend = join(root, 'backend');
const isWindows = process.platform === 'win32';
const venv = join(backend, '.venv');
const venvPython = join(
  venv,
  isWindows ? 'Scripts' : 'bin',
  isWindows ? 'python.exe' : 'python',
);

const run = (cmd, args, label) => {
  const r = spawnSync(cmd, args, { cwd: backend, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
};

/**
 * Find an interpreter new enough to build the venv. backend/.python-version asks
 * for 3.12; 3.11+ is the real floor, because the code uses `datetime.UTC` and
 * requirements.txt drops passlib specifically to survive 3.13. macOS ships a
 * system python3 that is often older, so prefer explicitly versioned names.
 */
const findPython = () => {
  const candidates = isWindows
    ? ['py -3.12', 'py -3.11', 'python']
    : ['python3.12', 'python3.11', 'python3'];
  for (const candidate of candidates) {
    const [cmd, ...pre] = candidate.split(' ');
    const probe = spawnSync(cmd, [...pre, '-c', 'import sys;print(sys.version_info[:2])'], {
      encoding: 'utf8',
    });
    if (probe.status !== 0) continue;
    const match = /\((\d+), (\d+)\)/.exec(probe.stdout ?? '');
    if (!match) continue;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    if (major === 3 && minor >= 11) return { cmd, pre, version: `${major}.${minor}` };
    console.log(`  skipping ${candidate} (Python ${major}.${minor}, need 3.11+)`);
  }
  return null;
};

if (!existsSync(venvPython)) {
  const found = findPython();
  if (!found) {
    console.error(
      'No Python 3.11+ found on PATH.\n' +
        (isWindows
          ? 'Install from https://python.org and re-run.\n'
          : 'Install one, e.g.  brew install python@3.12\n'),
    );
    process.exit(1);
  }
  console.log(`Creating virtualenv with Python ${found.version}…`);
  run(found.cmd, [...found.pre, '-m', 'venv', '.venv'], 'Creating the virtualenv');
} else {
  console.log('Virtualenv already exists — reusing it.');
}

console.log('Installing dependencies…');
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'], 'Upgrading pip');
run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], 'Installing requirements');

const env = join(backend, '.env');
const example = join(backend, '.env.example');
if (!existsSync(env)) {
  copyFileSync(example, env);
  console.log('\nCreated backend/.env from .env.example.');
  console.log('Edit it and set DATABASE_URL before running: npm run seed');
} else {
  console.log('\nbackend/.env already exists — left untouched.');
}

console.log('Backend setup complete.');

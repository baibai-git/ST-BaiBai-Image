import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStagedSizes } from './check-file-size.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const fixtures = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content);
}
function commit(root) {
  return spawnSync('git', ['-c', 'commit.gpgSign=false', '-c', 'user.name=SizeTest', '-c', 'user.email=size-test@localhost',
    'commit', '-m', 'size fixture'], { cwd: root, windowsHide: true, encoding: 'utf8' });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbi-size-'));
  fixtures.push(root);
  git(root, 'init', '-q');
  git(root, 'config', '--local', 'core.hooksPath', '.githooks');
  write(root, 'scripts/file-size-baseline.json', JSON.stringify({ 'old.ts': 24_000 }));
  write(root, 'old.ts', 'x'.repeat(24_000));
  git(root, 'add', '.');
  expect(commit(root).status).toBe(0);
  mkdirSync(join(root, '.githooks'), { recursive: true });
  copyFileSync(join(source, '.githooks/pre-commit'), join(root, '.githooks/pre-commit'));
  chmodSync(join(root, '.githooks/pre-commit'), 0o755);
  copyFileSync(join(source, 'scripts/check-file-size.mjs'), join(root, 'scripts/check-file-size.mjs'));
  git(root, 'add', '.');
  return root;
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + '/bbi-size-')
      && !resolve(root).startsWith(resolve(tmpdir()) + '\\bbi-size-')) throw new Error('unsafe fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('staged file size guard', () => {
  it('blocks a real oversized commit, then accepts split files; unstaged edits cannot hide staged bytes', () => {
    const root = fixture();
    write(root, 'new.ts', 'x'.repeat(20_001));
    git(root, 'add', '.');
    write(root, 'new.ts', 'tiny working copy');
    expect(checkStagedSizes(root)[0]).toContain('20001');
    const blocked = commit(root);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('new.ts');
    rmSync(join(root, 'new.ts'));
    write(root, 'first.ts', 'x'.repeat(10_000));
    write(root, 'second.ts', 'x'.repeat(10_001));
    git(root, 'add', '-A');
    expect(commit(root).status).toBe(0);
  }, 15_000);

  it('allows legacy shrinkage and rejects growth even below the original baseline', () => {
    const root = fixture();
    write(root, 'old.ts', 'x'.repeat(24_001));
    git(root, 'add', '.');
    expect(checkStagedSizes(root)[0]).toContain('old.ts');
    write(root, 'old.ts', 'x'.repeat(23_000));
    git(root, 'add', '.');
    expect(commit(root).status).toBe(0);
    write(root, 'old.ts', 'x'.repeat(23_001));
    git(root, 'add', '.');
    expect(checkStagedSizes(root)[0]).toContain('23000');
  }, 15_000);

  it('exempts only generated output, the generated layout table and lockfiles', () => {
    const root = fixture();
    for (const path of ['dist/index.js', 'src/manga/table.ts', 'pnpm-lock.yaml']) write(root, path, 'x'.repeat(50_000));
    git(root, 'add', '.');
    expect(checkStagedSizes(root)).toEqual([]);
    write(root, 'src/normal.ts', 'x'.repeat(20_001));
    git(root, 'add', '.');
    expect(checkStagedSizes(root)).toHaveLength(1);
  }, 15_000);

  it('refuses to disable an existing custom or default commit hook', () => {
    const root = fixture();
    const install = () => spawnSync(process.execPath, [join(source, 'scripts/install-hooks.mjs')], {
      cwd: root, windowsHide: true, encoding: 'utf8',
    });
    git(root, 'config', '--local', 'core.hooksPath', 'custom-hooks');
    expect(install().status).not.toBe(0);
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath').toString().trim()).toBe('custom-hooks');
    git(root, 'config', '--local', '--unset', 'core.hooksPath');
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
    expect(install().status).not.toBe(0);
    rmSync(join(root, '.git/hooks/pre-commit'));
    expect(install().status).toBe(0);
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath').toString().trim()).toBe('.githooks');
  }, 15_000);
});

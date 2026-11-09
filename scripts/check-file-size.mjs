import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 20_000;
const generated = path => path.startsWith('dist/') || path === 'src/manga/table.ts'
  || ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(path);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Inspect staged blobs, so an unstaged edit cannot disguise a large commit. */
export function checkStagedSizes(cwd = process.cwd()) {
  const root = git(cwd, 'rev-parse', '--show-toplevel').toString().trim();
  const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/file-size-baseline.json'), 'utf8'));
  let previousBaseline = null;
  try { previousBaseline = JSON.parse(git(root, 'show', 'HEAD:scripts/file-size-baseline.json').toString()); } catch { /* introducing the initial baseline */ }
  const paths = git(root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').toString().split('\0').filter(Boolean);
  const errors = [];
  for (const path of paths) {
    if (generated(path)) continue;
    const bytes = Number(git(root, 'cat-file', '-s', `:${path}`).toString());
    const recorded = baseline[path];
    let limit = LIMIT;
    if (Number.isSafeInteger(recorded) && recorded > LIMIT
      && (previousBaseline === null || previousBaseline[path] > LIMIT)) {
      let previous = recorded;
      if (previousBaseline !== null) {
        try { previous = Number(git(root, 'cat-file', '-s', `HEAD:${path}`).toString()); } catch { previous = LIMIT; }
      }
      limit = Math.max(LIMIT, Math.min(recorded, previous));
    }
    if (bytes > limit) errors.push(`${path}: ${bytes} 字节（约 ${Math.ceil(bytes / 4)} token），上限 ${limit} 字节。请按功能拆分；历史超标文件只允许缩小。`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = checkStagedSizes();
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log('文件大小检查通过。');
  } catch (error) {
    console.error(`文件大小检查失败：${error.message}`);
    process.exitCode = 1;
  }
}

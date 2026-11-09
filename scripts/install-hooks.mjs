import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'pipe', windowsHide: true }).toString().trim();
  let current = '';
  try { current = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { stdio: 'pipe', windowsHide: true }).toString().trim(); } catch { /* unset */ }
  if (current && current !== '.githooks') throw new Error(`已有 hooksPath=${current}；请将大小检查合入现有钩子，安装器不会覆盖。`);
  if (!current) {
    const existing = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], { stdio: 'pipe', windowsHide: true }).toString().trim();
    if (existsSync(resolve(existing))) throw new Error('已有默认 pre-commit 钩子；请合入大小检查，安装器不会覆盖。');
  }
  chmodSync(resolve(root, '.githooks/pre-commit'), 0o755);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { windowsHide: true });
  console.log('已启用 .githooks/pre-commit。');
} catch (error) {
  console.error(`钩子安装失败：${error.message}`);
  process.exitCode = 1;
}

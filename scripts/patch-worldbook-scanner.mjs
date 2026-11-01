import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Add an explicit request-local book list while retaining the native ST activation engine. */
export function patchWorldbookScanner(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let text = source.replaceAll('\r\n', '\n');
  if (text.includes('export async function checkWorldInfoForBooks(')) {
    if (!text.includes('const sortedEntries = await getSortedEntries(worldNamesOverride);')) {
      throw new Error('发现不同版本的专用书单补丁，请先人工核对，未修改文件。');
    }
    return { text: source, changed: false };
  }
  const pairs = [
    ['export async function getSortedEntries() {', 'export async function getSortedEntries(worldNamesOverride) {'],
    ['] = await Promise.all([\n            getGlobalLore(),', `] = Array.isArray(worldNamesOverride)
            ? [(await Promise.all([...new Set(worldNamesOverride)].map(async (worldName) => {
                const data = await loadWorldInfo(worldName);
                return data ? Object.values(data.entries ?? {}).map(entry => ({ ...entry, world: worldName })) : [];
            }))).flat(), [], [], []]
            : await Promise.all([
            getGlobalLore(),`],
    ['export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData) {',
      'export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData, worldNamesOverride) {'],
    ['const sortedEntries = await getSortedEntries();', 'const sortedEntries = await getSortedEntries(worldNamesOverride);'],
    ['//MARK: checkWorldInfo\n', `/** Scan an explicit, request-local book list without changing global/chat/character selections. */
export async function checkWorldInfoForBooks(chat, maxContext, isDryRun, worldNames, globalScanData) {
    if (!Array.isArray(worldNames) || worldNames.some(name => typeof name !== 'string' || !name.trim())) {
        throw new TypeError('worldNames must be an array of non-empty book names');
    }
    return checkWorldInfo(chat, maxContext, isDryRun, globalScanData, [...new Set(worldNames)]);
}

//MARK: checkWorldInfo
`],
  ];
  for (const [before, after] of pairs) {
    if (text.split(before).length !== 2) throw new Error('此酒馆版本的扫描器结构不匹配，未修改文件。');
    text = text.replace(before, after);
  }
  return { text: text.replaceAll('\n', eol), changed: true };
}

async function findRoot() {
  for (let dir = dirname(fileURLToPath(import.meta.url));;) {
    try { await access(join(dir, 'public/scripts/world-info.js')); return dir; } catch {}
    const parent = dirname(dir);
    if (dir === parent) throw new Error('未找到酒馆根目录，请将根目录路径作为最后一个参数。');
    dir = parent;
  }
}

async function main() {
  const [mode = '--check', rootArg, ...rest] = process.argv.slice(2);
  if (!['--check', '--apply'].includes(mode) || rest.length) {
    throw new Error('用法：node scripts/patch-worldbook-scanner.mjs [--check|--apply] [酒馆根目录]');
  }
  const target = join(rootArg ? resolve(rootArg) : await findRoot(), 'public/scripts/world-info.js');
  const before = await readFile(target, 'utf8');
  const result = patchWorldbookScanner(before);
  if (!result.changed) { console.log('专用世界书扫描接口已安装，无需修改。'); return; }
  if (mode === '--check') { console.log('兼容检查通过；尚未修改文件。使用 --apply 安装。'); return; }
  // Back up before writing; refuse an update if another process changed the source meanwhile.
  const backup = `${target}.bbi-worldbooks-${Date.now()}.bak`;
  await writeFile(backup, before, { encoding: 'utf8', flag: 'wx' });
  if (await readFile(target, 'utf8') !== before) throw new Error('源文件刚被其他进程修改，已停止安装。');
  await writeFile(target, result.text, 'utf8');
  if (await readFile(target, 'utf8') !== result.text) throw new Error('写回核验失败，请使用备份恢复。');
  console.log(`已安装，请刷新酒馆。备份：${backup}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

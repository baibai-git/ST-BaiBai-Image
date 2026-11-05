import { describe, expect, it } from 'vitest';
import { patchWorldbookScanner } from './patch-worldbook-scanner.mjs';

const host = `export async function getSortedEntries() {
    const [globalLore, characterLore, chatLore, personaLore] = await Promise.all([
            getGlobalLore(),
            Promise.resolve([]), Promise.resolve([]), Promise.resolve([]),
    ]);
        await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });
    return globalLore;
}
//MARK: checkWorldInfo
export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData) {
    const sortedEntries = await getSortedEntries();
    return sortedEntries;
}
`;

describe('宿主专用书单兼容补丁', () => {
  it('独立书单调用隔离，默认路径仍读取原书单，并且重复安装无改动', async () => {
    const patched = patchWorldbookScanner(host);
    expect(patched.changed).toBe(true);
    expect(patchWorldbookScanner(patched.text)).toEqual({ text: patched.text, changed: false });
    const source = patched.text.replaceAll('export ', '');
    const normal = [{ world: 'Original', uid: 1, content: 'Original' }];
    const api = new Function('getGlobalLore', 'loadWorldInfo', 'defaultGlobalScanData', 'eventSource', 'event_types', `${source}; return {checkWorldInfo,checkWorldInfoForBooks,checkWorldInfoWithAdditionalBooks};`)(
      async () => [...normal],
      async world => ({ entries: { 1: { uid: 1, content: world } } }), {}, { emit: async () => {} }, { WORLDINFO_ENTRIES_LOADED: 'loaded' },
    );
    const [a, b, standard] = await Promise.all([
      api.checkWorldInfoForBooks([], 100, true, ['A', 'A']),
      api.checkWorldInfoForBooks([], 100, true, ['B']),
      api.checkWorldInfo([], 100, true),
    ]);
    expect(a.map(e => e.world)).toEqual(['A']);
    expect(b.map(e => e.world)).toEqual(['B']);
    expect(standard).toEqual(normal);
    expect(normal).toEqual([{ world: 'Original', uid: 1, content: 'Original' }]);
    const overlay = await api.checkWorldInfoWithAdditionalBooks([], 100, true, ['Original', 'A', 'A']);
    expect(overlay.map(e => e.world)).toEqual(['Original', 'A']);
    expect(await api.checkWorldInfoWithAdditionalBooks([], 100, true, [])).toEqual(normal);
    await expect(api.checkWorldInfoWithAdditionalBooks([], 100, true, [''])).rejects.toThrow();
    expect(await api.checkWorldInfoForBooks([], 100, true, [])).toEqual([]);
    await expect(api.checkWorldInfoForBooks([], 100, true, [''])).rejects.toThrow();
  });
  it('已有专用补丁可升级，升级后不重复注入合并代码', () => {
    const current = patchWorldbookScanner(host).text;
    const old = current
      .replace(/        \/\/ Request-local overlay;[\s\S]*?(?=        await eventSource.emit)/, '')
      .replace(/\/\*\* Merge normal books[\s\S]*?(?=\/\/MARK: checkWorldInfo)/, '');
    const upgraded = patchWorldbookScanner(old);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.text).toBe(current);
    expect(patchWorldbookScanner(upgraded.text).changed).toBe(false);
    const incomplete = current.replace('Array.isArray(worldNamesOverride?.additionalWorldNames)', 'false');
    expect(() => patchWorldbookScanner(incomplete)).toThrow('不完整');
  });
  it('不匹配的宿主和不完整的已有补丁应拒绝修改', () => {
    expect(() => patchWorldbookScanner('unrelated source')).toThrow('不匹配');
    expect(() => patchWorldbookScanner('export async function checkWorldInfoForBooks(')).toThrow('不同版本');
  });
  it('保留 CRLF 换行', () => {
    const result = patchWorldbookScanner(host.replaceAll('\n', '\r\n'));
    expect(result.text.replaceAll('\r\n', '')).not.toContain('\n');
  });
});

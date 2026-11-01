import { describe, expect, it } from 'vitest';
import { patchWorldbookScanner } from './patch-worldbook-scanner.mjs';

const host = `export async function getSortedEntries() {
    const [globalLore] = await Promise.all([
            getGlobalLore(),
    ]);
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
    const normal = ['Original'];
    const api = new Function('getGlobalLore', 'loadWorldInfo', 'defaultGlobalScanData', `${source}; return {checkWorldInfo,checkWorldInfoForBooks};`)(
      async () => [...normal],
      async world => ({ entries: { 1: { uid: 1, content: world } } }), {},
    );
    const [a, b, standard] = await Promise.all([
      api.checkWorldInfoForBooks([], 100, true, ['A', 'A']),
      api.checkWorldInfoForBooks([], 100, true, ['B']),
      api.checkWorldInfo([], 100, true),
    ]);
    expect(a.map(e => e.world)).toEqual(['A']);
    expect(b.map(e => e.world)).toEqual(['B']);
    expect(standard).toEqual(['Original']);
    expect(normal).toEqual(['Original']);
    expect(await api.checkWorldInfoForBooks([], 100, true, [])).toEqual([]);
    await expect(api.checkWorldInfoForBooks([], 100, true, [''])).rejects.toThrow();
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

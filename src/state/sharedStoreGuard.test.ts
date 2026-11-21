import { afterEach, expect, it, vi } from 'vitest';

const sharedKey = 'baibai_exclude_settings';
const emptyExcludes = () => ({
  excludedChars: [], excludedWorldNames: [], excludedWorldInfoPatterns: ['\\[mvu[\\s\\S]*?\\]'], customStripTags: [],
});

async function reload(extensionSettings: Record<string, unknown>) {
  vi.resetModules();
  const context = { extensionSettings };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { SillyTavern: { getContext: () => context } }));
  const { hydrateSettings, settings } = await import('./settings');
  await hydrateSettings();
  return settings.excludes;
}

afterEach(() => vi.unstubAllGlobals());

it('首次加载空名单时只启用本地默认规则，不占用共享名单', async () => {
  const saved = { baibai_image: {} };
  expect(await reload(saved)).toEqual(emptyExcludes());
  expect(saved).not.toHaveProperty(sharedKey);
});

it('旧版空共享名单不会覆盖已保存的排除，修复后重新加载仍存在', async () => {
  const local = {
    excludedChars: ['小雪'], excludedWorldNames: ['设定集'],
    excludedWorldInfoPatterns: ['^状态'], customStripTags: ['private'],
  };
  const saved = { baibai_image: { excludes: local }, [sharedKey]: { revision: 2, ...emptyExcludes() } };
  const repaired = await reload(saved);
  expect(repaired).toEqual(local);
  expect(saved[sharedKey]).toMatchObject(local);
  expect(await reload(JSON.parse(JSON.stringify(saved)))).toEqual(local);
});

it('已有共享名单时载入该名单，保留其它插件维护的世界书排除', async () => {
  const remote = { ...emptyExcludes(), excludedWorldNames: ['来自柏宝书的排除'] };
  const saved = { baibai_image: { excludes: { ...emptyExcludes(), excludedChars: ['旧副本'] } }, [sharedKey]: { revision: 3, ...remote } };
  expect(await reload(saved)).toEqual(remote);
  expect(saved[sharedKey]).toEqual({ revision: 3, ...remote });
});

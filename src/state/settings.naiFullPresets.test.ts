import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: null as any }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
});
it('migrates the complete current recipe without changing prompts, parameters or connections, and persists named presets across hydration', async () => {
  mocks.context = {
    extensionSettings: {
      baibai_image: {
        nai: {
          key: 'SECRET',
          url: 'https://private',
          model: 'nai-diffusion-4-5-full',
          scale: 7,
          steps: 32,
          seed: 123,
          qualityTags: 'channel quality',
          undesiredContent: 'channel negative',
          artistPresets: [
            {
              id: 'art_old',
              name: 'Old',
              prompt: 'artist:old',
              quality: 'bound quality',
              negative: 'bound negative',
            },
          ],
          activeArtistId: 'art_old',
        },
      },
    },
    saveSettingsDebounced: vi.fn(),
  };
  let module = await import('./settings');
  await module.hydrateSettings();
  const n = module.settings.nai;
  expect(n.fullPresets).toHaveLength(1);
  expect(n.fullPresets[0].name).toBe('当前配置');
  expect(n.fullPresets[0].snapshot.artist?.prompt).toBe('artist:old');
  expect(n.fullPresets[0].snapshot.steps).toBe(32);
  expect(n.activeFullPresetId).toBe(n.fullPresets[0].id);
  expect(n.activeArtistId).toBe('art_old');
  expect(n.scale).toBe(7);
  expect(n.key).toBe('SECRET');
  expect(JSON.stringify(n.fullPresets)).not.toContain('SECRET');
  n.fullPresets[0].name = 'Saved';
  n.fullPresets[0].snapshot.steps = 40;
  n.steps = 20;
  await (await import('vue')).nextTick();
  const stored = JSON.parse(JSON.stringify(mocks.context.extensionSettings.baibai_image));
  vi.resetModules();
  mocks.context.extensionSettings.baibai_image = stored;
  module = await import('./settings');
  await module.hydrateSettings();
  expect(module.settings.nai.fullPresets[0].name).toBe('Saved');
  expect(module.settings.nai.fullPresets[0].snapshot.steps).toBe(40);
  expect(module.settings.nai.steps).toBe(20); // Keep an unsaved working draft after reload.
});

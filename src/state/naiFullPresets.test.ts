import { describe, it, expect } from 'vitest';
import {
  captureNaiFullSnapshot,
  applyNaiFullSnapshot,
  exportNaiFullPreset,
  importNaiFullPreset,
  normalizeNaiFullSnapshot,
  refreshNaiFullVibeReferences,
} from './naiFullPresets';
const nai = () =>
  ({
    url: 'https://private',
    key: 'SECRET',
    endpoints: [{ id: 'ep', url: 'https://private', key: 'SECRET' }],
    activeEndpointId: 'ep',
    model: 'nai-diffusion-5-full',
    qualityTags: 'quality',
    undesiredContent: 'negative',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    orientationLock: 'auto',
    sampler: 'k_euler',
    steps: 28,
    scale: 5.5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    naturalLanguage: true,
    concurrency: 1,
    activeArtistId: 'art_1',
    artistPresets: [
      {
        id: 'art_1',
        name: 'A',
        prompt: 'artist:a',
        quality: 'bound quality',
        negative: 'bound negative',
        previewPath: '/user/secret',
      },
    ],
    vibes: [
      {
        id: 'v1',
        name: 'V1',
        fingerprint: 'fp1',
        dataPath: '/user/files/reference',
        thumbnailPath: '/user/images/thumb',
        enabled: true,
        strength: 0.7,
        group: 'G',
        modelKeys: ['nai-diffusion-5-full'],
        hasImage: true,
      },
    ],
  }) as any;
describe('完整 NAI 生图预设', () => {
  it('retains long multi-model fingerprints and migrates only references to the reencoded image', () => {
    const n = nai();
    n.vibes[0].fingerprint = 'model-encoding:'.repeat(40);
    const baseline = captureNaiFullSnapshot(n, null);
    const p = importNaiFullPreset(
      exportNaiFullPreset({ id: 'nfp_long', name: 'Long', snapshot: baseline }),
      baseline,
    );
    expect(applyNaiFullSnapshot(n, p.snapshot)).toEqual([]);
    expect(n.vibes[0].enabled).toBe(true);
    const other = { id: 'nfp_other', name: 'Other', snapshot: captureNaiFullSnapshot(n, null) };
    other.snapshot.vibes[0].fingerprint = 'unrelated';
    refreshNaiFullVibeReferences([p, other], 'v1', n.vibes[0].fingerprint, 'new-encoding');
    n.vibes[0].fingerprint = 'new-encoding';
    expect(applyNaiFullSnapshot(n, p.snapshot)).toEqual([]);
    expect(other.snapshot.vibes[0].fingerprint).toBe('unrelated');
  });
  it('snapshot captures the recipe without channels, keys, image paths or mutable aliases', () => {
    const n = nai(),
      s = captureNaiFullSnapshot(n, n.artistPresets[0]);
    expect(s.artist?.prompt).toBe('artist:a');
    expect(s.steps).toBe(28);
    expect(s.vibes[0].strength).toBe(0.7);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|https:|dataPath|previewPath|thumbnailPath/);
    n.artistPresets[0].prompt = 'changed';
    n.vibes[0].strength = 0.1;
    expect(s.artist?.prompt).toBe('artist:a');
    expect(s.vibes[0].strength).toBe(0.7);
  });
  it('applying switches prompts and parameters together while keeping connections, unrelated libraries and saved snapshot intact', () => {
    const n = nai(),
      s = captureNaiFullSnapshot(n, n.artistPresets[0]);
    s.model = 'nai-diffusion-4-5-full';
    s.steps = 35;
    s.artist!.prompt = 'artist:b';
    s.vibes[0].strength = 0.9;
    n.vibes.push({ ...n.vibes[0], id: 'v2', fingerprint: 'fp2' });
    const missing = applyNaiFullSnapshot(n, s);
    expect(missing).toEqual([]);
    expect(n.model).toBe('nai-diffusion-4-5-full');
    expect(n.steps).toBe(35);
    expect(n.artistPresets.find((a: any) => a.id === n.activeArtistId).prompt).toBe('artist:b');
    expect(n.key).toBe('SECRET');
    expect(n.activeEndpointId).toBe('ep');
    expect(n.vibes[0].strength).toBe(0.9);
    expect(n.vibes[1].enabled).toBe(false);
    n.artistPresets.find((a: any) => a.id === n.activeArtistId).prompt = 'draft';
    expect(s.artist?.prompt).toBe('artist:b');
  });
  it('missing references are reported and cannot enable the wrong local image', () => {
    const n = nai(),
      s = captureNaiFullSnapshot(n, null);
    s.vibes = [
      { id: 'v1', fingerprint: 'different', name: 'missing', enabled: true, strength: 0.8 },
    ];
    expect(applyNaiFullSnapshot(n, s)).toEqual(['missing']);
    expect(n.vibes[0].enabled).toBe(false);
    expect(n.activeArtistId).toBe('');
  });
  it('roundtrip export is complete and sanitizes injected sensitive fields; import creates a separate preset', () => {
    const n = nai(),
      preset = {
        id: 'nfp_original',
        name: 'Test',
        snapshot: captureNaiFullSnapshot(n, n.artistPresets[0]),
      };
    const text = exportNaiFullPreset(preset);
    expect(text).not.toContain('SECRET');
    const parsed = JSON.parse(text);
    parsed.preset.snapshot.key = 'LEAK';
    parsed.preset.snapshot.endpoints = n.endpoints;
    const imported = importNaiFullPreset(JSON.stringify(parsed), preset.snapshot);
    expect(imported.id).not.toBe(preset.id);
    expect(imported.snapshot.artist?.prompt).toBe('artist:a');
    expect(JSON.stringify(imported)).not.toMatch(/LEAK|SECRET/);
    expect(() => importNaiFullPreset('{"format":"other"}', preset.snapshot)).toThrow();
    expect(() => importNaiFullPreset('{broken', preset.snapshot)).toThrow();
  });
  it('normalizes malformed values without constructing unsafe recipes', () => {
    const baseline = captureNaiFullSnapshot(nai(), null);
    const s = normalizeNaiFullSnapshot(
      {
        ...baseline,
        steps: 999,
        scale: -1,
        seed: Infinity,
        model: 'unknown',
        portraitSize: 'bad',
        vibes: [null, {}],
      },
      baseline,
    );
    expect(s.steps).toBe(50);
    expect(s.scale).toBe(0);
    expect(s.seed).toBe(0);
    expect(s.model).toBe(baseline.model);
    expect(s.portraitSize).toBe(baseline.portraitSize);
    expect(s.vibes).toEqual([]);
  });
});

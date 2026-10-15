import type { NaiSettings, NaiArtistPreset, NaiModel } from './settings';

const stringKeys = [
  'qualityTags',
  'undesiredContent',
  'portraitSize',
  'landscapeSize',
  'sampler',
  'noiseSchedule',
] as const;
const boolKeys = ['varietyBoost', 'normalizeRefStrength', 'naturalLanguage'] as const;
const numbers = {
  steps: [1, 50],
  scale: [0, 35],
  cfgRescale: [0, 1],
  seed: [0, 4294967295],
  concurrency: [1, 4],
} as const;
const models = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
];
export interface NaiFullVibe {
  id: string;
  name: string;
  fingerprint: string;
  enabled: boolean;
  strength: number;
}
export type NaiFullSnapshot = Pick<
  NaiSettings,
  | (typeof stringKeys)[number]
  | (typeof boolKeys)[number]
  | keyof typeof numbers
  | 'model'
  | 'orientationLock'
> & {
  artist: Pick<NaiArtistPreset, 'name' | 'prompt' | 'quality' | 'negative'> | null;
  vibes: NaiFullVibe[];
};
export interface NaiFullPreset {
  id: string;
  name: string;
  snapshot: NaiFullSnapshot;
}
const text = (value: unknown, max = 100000) =>
  typeof value === 'string' ? value.slice(0, max) : '';
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
let sequence = 0;
export const newNaiFullPresetId = () =>
  `nfp_${Date.now()}_${++sequence}_${Math.random().toString(36).slice(2, 7)}`;

export function captureNaiFullSnapshot(
  nai: NaiSettings,
  artist: NaiArtistPreset | null,
): NaiFullSnapshot {
  const result = {} as NaiFullSnapshot;
  for (const key of stringKeys) result[key] = nai[key];
  for (const key of boolKeys) result[key] = nai[key];
  for (const key of Object.keys(numbers) as (keyof typeof numbers)[]) result[key] = nai[key];
  result.model = nai.model;
  result.orientationLock = nai.orientationLock;
  result.artist = artist
    ? {
        name: artist.name,
        prompt: artist.prompt,
        quality: artist.quality,
        negative: artist.negative,
      }
    : null;
  result.vibes = nai.vibes.map((v) => ({
    id: v.id,
    name: v.name,
    fingerprint: v.fingerprint,
    enabled: v.enabled,
    strength: v.strength,
  }));
  return result;
}

export function normalizeNaiFullSnapshot(raw: unknown, fallback: NaiFullSnapshot): NaiFullSnapshot {
  const o = object(raw),
    result = {} as NaiFullSnapshot;
  for (const key of stringKeys)
    result[key] = typeof o[key] === 'string' ? text(o[key]) : fallback[key];
  for (const key of ['portraitSize', 'landscapeSize'] as const) {
    const match = result[key].match(/^(\d+)\s*[x×X]\s*(\d+)$/);
    if (
      !match ||
      Number(match[1]) < 64 ||
      Number(match[2]) < 64 ||
      Number(match[1]) > 8192 ||
      Number(match[2]) > 8192
    )
      result[key] = fallback[key];
  }
  for (const key of boolKeys)
    result[key] = typeof o[key] === 'boolean' ? (o[key] as boolean) : fallback[key];
  for (const key of Object.keys(numbers) as (keyof typeof numbers)[]) {
    const [min, max] = numbers[key];
    result[key] = clamp(o[key], fallback[key], min, max);
  }
  for (const key of ['steps', 'seed', 'concurrency'] as const)
    result[key] = Math.round(result[key]);
  result.model = models.includes(String(o.model)) ? (o.model as NaiModel) : fallback.model;
  result.orientationLock = ['auto', 'portrait', 'landscape'].includes(String(o.orientationLock))
    ? (o.orientationLock as NaiFullSnapshot['orientationLock'])
    : fallback.orientationLock;
  if (o.artist === null) result.artist = null;
  else if (o.artist && typeof o.artist === 'object') {
    const a = object(o.artist);
    result.artist = {
      name: text(a.name, 100) || '预设画师串',
      prompt: text(a.prompt),
      quality: text(a.quality),
      negative: text(a.negative),
    };
  } else result.artist = fallback.artist ? { ...fallback.artist } : null;
  const seen = new Set<string>();
  result.vibes = (Array.isArray(o.vibes) ? o.vibes : fallback.vibes).slice(0, 2000).flatMap((v) => {
    const r = object(v),
      id = text(r.id, 200),
      fingerprint = text(r.fingerprint),
      identity = fingerprint || id;
    if (!identity || seen.has(identity)) return [];
    seen.add(identity);
    return [
      {
        id,
        fingerprint,
        name: text(r.name, 200) || 'Vibe',
        enabled: r.enabled === true,
        strength: clamp(r.strength, 0.6, 0, 1),
      },
    ];
  });
  return result;
}

export function applyNaiFullSnapshot(nai: NaiSettings, snapshot: NaiFullSnapshot): string[] {
  // Only recipe fields are applied. Connections and all reference binaries stay in their existing stores.
  const s = normalizeNaiFullSnapshot(snapshot, snapshot);
  for (const key of stringKeys) nai[key] = s[key];
  for (const key of boolKeys) nai[key] = s[key];
  for (const key of Object.keys(numbers) as (keyof typeof numbers)[]) nai[key] = s[key];
  nai.model = s.model;
  nai.orientationLock = s.orientationLock;
  if (s.artist) {
    const id = 'art_full_preset_working',
      artist = { id, ...s.artist };
    const i = nai.artistPresets.findIndex((a) => a.id === id);
    if (i < 0) nai.artistPresets.push(artist);
    else nai.artistPresets[i] = artist;
    nai.activeArtistId = id;
  } else nai.activeArtistId = '';
  const missing: string[] = [];
  for (const v of nai.vibes) v.enabled = false;
  for (const v of s.vibes) {
    const local = v.fingerprint
      ? nai.vibes.find((x) => x.fingerprint === v.fingerprint)
      : nai.vibes.find((x) => x.id === v.id);
    if (local) {
      local.enabled = v.enabled;
      local.strength = v.strength;
    } else if (v.enabled) missing.push(v.name);
  }
  return missing;
}

export function normalizeNaiFullPresets(raw: unknown, baseline: NaiFullSnapshot): NaiFullPreset[] {
  const seen = new Set<string>();
  if (!Array.isArray(raw))
    return [
      {
        id: 'nfp_current',
        name: '当前配置',
        snapshot: normalizeNaiFullSnapshot(baseline, baseline),
      },
    ];
  return raw.slice(0, 500).flatMap((value) => {
    const p = object(value),
      id = text(p.id, 200);
    if (
      !/^nfp_[a-zA-Z0-9_-]+$/.test(id) ||
      seen.has(id) ||
      !p.snapshot ||
      typeof p.snapshot !== 'object'
    )
      return [];
    seen.add(id);
    return [
      {
        id,
        name: text(p.name, 100).trim() || '未命名预设',
        snapshot: normalizeNaiFullSnapshot(p.snapshot, baseline),
      },
    ];
  });
}

export function refreshNaiFullVibeReferences(
  presets: NaiFullPreset[],
  id: string,
  oldFingerprint: string,
  newFingerprint: string,
): void {
  for (const preset of presets)
    for (const ref of preset.snapshot.vibes) {
      if (oldFingerprint ? ref.fingerprint === oldFingerprint : !ref.fingerprint && ref.id === id)
        ref.fingerprint = newFingerprint;
    }
}

export function exportNaiFullPreset(preset: NaiFullPreset): string {
  return JSON.stringify(
    {
      format: 'bbi-nai-full-preset',
      version: 1,
      preset: {
        name: preset.name,
        snapshot: normalizeNaiFullSnapshot(preset.snapshot, preset.snapshot),
      },
    },
    null,
    2,
  );
}
export function naiFullSnapshotSignature(s: NaiFullSnapshot): string {
  const normalized = normalizeNaiFullSnapshot(s, s);
  return JSON.stringify({
    ...normalized,
    artist: normalized.artist
      ? {
          prompt: normalized.artist.prompt,
          quality: normalized.artist.quality,
          negative: normalized.artist.negative,
        }
      : null,
    vibes: normalized.vibes
      .filter((v) => v.enabled)
      .map((v) => ({ identity: v.fingerprint || v.id, strength: v.strength }))
      .sort((a, b) => a.identity.localeCompare(b.identity)),
  });
}
export function importNaiFullPreset(raw: string, baseline: NaiFullSnapshot): NaiFullPreset {
  if (raw.length > 2 * 1024 * 1024) throw Error('预设文件不能超过 2 MB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error('不是有效的 JSON 预设文件');
  }
  const doc = object(parsed),
    p = object(doc.preset),
    s = object(p.snapshot);
  if (
    doc.format !== 'bbi-nai-full-preset' ||
    doc.version !== 1 ||
    !text(p.name, 100).trim() ||
    !models.includes(String(s.model))
  )
    throw Error('不是受支持的柏宝绘完整生图预设');
  return {
    id: newNaiFullPresetId(),
    name: text(p.name, 100).trim(),
    snapshot: normalizeNaiFullSnapshot(s, baseline),
  };
}

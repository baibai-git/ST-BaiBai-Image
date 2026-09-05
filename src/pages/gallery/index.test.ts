import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import Gallery from './index.vue';
import { listUserImageFolders, listUserImages } from '@/st/images';

vi.mock('@/components/Icon.vue', () => ({ default: () => null }));
vi.mock('@/floor/lightbox', () => ({ openLightbox: vi.fn() }));
vi.mock('@/floor/storage', () => ({ readStore: vi.fn(), sidecarPathFor: vi.fn() }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: [], name2: 'Alpha' }) }));
vi.mock('@/st/images', () => ({
  ARTIST_PREVIEW_FOLDER: 'artist-previews',
  listUserImageFolders: vi.fn(),
  listUserImages: vi.fn(),
}));
vi.mock('vue', async importOriginal => {
  const vue = await importOriginal<typeof import('vue')>();
  // Keep Vue's real rendering and events; CSS transitions and native input listeners need a browser.
  return { ...vue, Transition: vue.BaseTransition, vModelText: {} };
});

// Vitest's Node pipeline supplies SSR output; compile the same template for client-side node checks.
const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'));
const template = compileTemplate({
  source: descriptor.template!.content,
  filename: 'index.vue',
  id: 'gallery-test',
  compilerOptions: {
    mode: 'function',
    bindingMetadata: compileScript(descriptor, { id: 'gallery-test' }).bindings,
  },
});
if (template.errors.length) throw new Error(template.errors.join('\n'));
const ClientGallery = { ...Gallery, render: new Function('Vue', template.code)(Vue) };

interface TestNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}

function node(type: string, text = ''): TestNode {
  return { type, text, props: {}, children: [], parent: null };
}

function remove(child: TestNode): void {
  if (!child.parent) return;
  child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}

function insert(child: TestNode, parent: TestNode, anchor?: TestNode | null): void {
  remove(child);
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  child.parent = parent;
}

// A small in-memory host lets the existing Node test suite count actual Vue-rendered nodes.
const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _previous, value) => { target.props[key] = value; },
  parentNode: target => target.parent,
  nextSibling: target => {
    const siblings = target.parent?.children ?? [];
    return siblings[siblings.indexOf(target) + 1] ?? null;
  },
  insert,
  remove,
  insertStaticContent: (content, parent, anchor) => {
    const target = node('#static', content);
    insert(target, parent, anchor);
    return [target, target];
  },
});

function find(root: TestNode, selector: string): TestNode[] {
  const matches = selector.startsWith('.')
    ? String(root.props.class ?? '').split(' ').includes(selector.slice(1))
    : root.type === selector;
  return [...(matches ? [root] : []), ...root.children.flatMap(child => find(child, selector))];
}

async function click(target: TestNode): Promise<void> {
  (target.props.onClick as () => void)();
  await nextTick();
}

const prefix = '\u67cf\u5b9d\u7ed8_';
const alpha = `${prefix}Alpha`;
const beta = `${prefix}Beta`;
const expandedKey = 'bbi.ui.galleryExpanded.v1';
let stored: Map<string, string>;
let app: ReturnType<typeof renderer.createApp> | undefined;

async function mount(): Promise<TestNode> {
  app?.unmount();
  const root = node('root');
  app = renderer.createApp(ClientGallery);
  app.provide(ssrContextKey, {});
  app.mount(root);
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
  return root;
}

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  });
  vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta]);
  vi.mocked(listUserImages).mockImplementation(async folder =>
    Array.from({ length: folder === alpha ? 53 : 5 }, (_, i) => `image-${i}.png`),
  );
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('gallery on-demand rendering', () => {
  it('starts folded without image nodes, including when old collapsed preferences exist', async () => {
    stored.set('bbi.ui.galleryCollapsed.v1', JSON.stringify([beta]));
    const root = await mount();
    expect(find(root, '.gal-fold-head').map(head => head.props['aria-expanded'])).toEqual([false, false]);
    expect(find(root, 'img')).toHaveLength(0);
    expect(find(root, '.gal-fold-wrap')).toHaveLength(0);
  });

  it('adds at most 24 images per click, handles the remainder and unloads folded groups', async () => {
    const root = await mount();
    const [alphaHead, betaHead] = find(root, '.gal-fold-head');
    await click(alphaHead);
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, 'img').every(image => image.props.loading === 'lazy')).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
    expect(find(root, '.gal-more')[0].children.some(child => child.text.includes('5'))).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(53);
    expect(find(root, '.gal-more')).toHaveLength(0);

    await click(alphaHead);
    expect(find(root, 'img')).toHaveLength(0);
    expect(find(root, '.gal-thumb')).toHaveLength(0);
    await click(alphaHead);
    expect(find(root, 'img')).toHaveLength(53);
    await click(betaHead);
    expect(find(root, 'img')).toHaveLength(58);
    expect(find(root, '.gal-more')).toHaveLength(0);
  });

  it('remembers manual expansion but resets batch sizes on remount and folds new groups', async () => {
    let root = await mount();
    await click(find(root, '.gal-fold-head')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(JSON.parse(stored.get(expandedKey)!)).toEqual([alpha]);

    vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta, `${prefix}Gamma`]);
    root = await mount();
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, '.gal-fold-head').map(head => head.props['aria-expanded'])).toEqual([true, false, false]);
    await click(find(root, '.gal-fold-head')[0]);
    expect(JSON.parse(stored.get(expandedKey)!)).toEqual([]);
    root = await mount();
    expect(find(root, 'img')).toHaveLength(0);
  });

  it.each(['invalid json', '{}', 'null', '[123, null]'])(
    'falls back to folded groups for unusable preferences: %s',
    async raw => {
      stored.set(expandedKey, raw);
      expect(find(await mount(), 'img')).toHaveLength(0);
    },
  );

  it('still toggles and loads batches when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage disabled'); },
      setItem: () => { throw new Error('Storage disabled'); },
    });
    const root = await mount();
    expect(find(root, 'img')).toHaveLength(0);
    await click(find(root, '.gal-fold-head')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
  });

  it('does not open groups just because they match a search', async () => {
    const root = await mount();
    (find(root, 'input')[0].props['onUpdate:modelValue'] as (query: string) => void)('Beta');
    await nextTick();
    expect(find(root, '.gal-fold-head')).toHaveLength(1);
    expect(find(root, 'img')).toHaveLength(0);
    await click(find(root, '.gal-fold-head')[0]);
    expect(find(root, 'img')).toHaveLength(5);
  });
});

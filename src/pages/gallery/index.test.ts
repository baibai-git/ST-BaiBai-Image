import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import Gallery from './index.vue';
import { listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { deleteImageFileOnly } from '@/floor/storage';
import { isImageMissing, resetMissingImages } from '@/floor/missingImages';
import { openLightbox } from '@/floor/lightbox';
import { confirmDialog } from '@/components/confirm';

declare const toastr: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

vi.mock('@/components/Icon.vue', () => ({ default: () => null }));
vi.mock('@/components/confirm', () => ({ confirmDialog: vi.fn() }));
vi.mock('@/floor/lightbox', () => ({ openLightbox: vi.fn() }));
vi.mock('@/floor/storage', () => ({
  readStore: vi.fn(),
  sidecarPathFor: vi.fn(),
  deleteImageFileOnly: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: [], name2: 'Alpha' }) }));
vi.mock('@/st/images', () => ({
  ARTIST_PREVIEW_FOLDER: 'artist-previews',
  listUserImageFolders: vi.fn(),
  listUserImages: vi.fn(),
  probeUserImage: vi.fn(),
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

/** \u6587\u672c\u5185\u5bb9\uff08\u542b\u5168\u90e8\u540e\u4ee3\uff09\u3002\u63d2\u503c\u4f1a\u5404\u81ea\u6210\u4e00\u4e2a #text \u8282\u70b9\uff0c\u9010\u5c42\u62fc\u8d77\u6765\u624d\u770b\u5f97\u5230\u6574\u53e5\u3002 */
function text(target: TestNode): string {
  return target.text + target.children.map(text).join('');
}

/** \u6392\u7a7a\u5fae\u4efb\u52a1 + \u4e00\u4e2a\u5b8f\u4efb\u52a1\uff1a\u7ec4\u4ef6\u91cc await \u8fc7\u7f51\u7edc\u7684\u90a3\u4e9b\u5206\u652f\u8981\u7b49\u5b83\u624d\u843d\u5230 DOM \u4e0a\u3002 */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
}

async function click(target: TestNode): Promise<void> {
  (target.props.onClick as () => void)();
  await nextTick();
}

async function change(target: TestNode): Promise<void> {
  (target.props.onChange as () => void)();
  await nextTick();
}

const prefix = '\u67cf\u5b9d\u7ed8_';
const alpha = `${prefix}Alpha`;
const beta = `${prefix}Beta`;
const expandedKey = 'bbi.ui.galleryExpanded.v1';
/** 删除调用要的是归一化 key（解码、无前导斜杠），与组件 image.key、markImagesMissing 同一口径；<img> 用的编码 src 是另一回事（见 imageSrc）。 */
const keyOf = (folder: string, file: string) => `user/images/${folder}/${file}`;
let stored: Map<string, string>;
let app: ReturnType<typeof renderer.createApp> | undefined;

async function mount(): Promise<TestNode> {
  app?.unmount();
  const root = node('root');
  app = renderer.createApp(ClientGallery);
  app.provide(ssrContextKey, {});
  app.mount(root);
  await flush();
  return root;
}

beforeEach(() => {
  stored = new Map();
  resetMissingImages();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  });
  vi.stubGlobal('toastr', { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() });
  vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta]);
  vi.mocked(listUserImages).mockImplementation(async folder =>
    Array.from({ length: folder === alpha ? 53 : 5 }, (_, i) => `image-${i}.png`),
  );
  vi.mocked(probeUserImage).mockResolvedValue({ exists: true, size: 1024 });
  vi.mocked(deleteImageFileOnly).mockResolvedValue(undefined);
  vi.mocked(confirmDialog).mockResolvedValue(true);
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
    expect(find(root, '.gal-fold-trigger').map(head => head.props['aria-expanded'])).toEqual([false, false]);
    expect(find(root, 'img')).toHaveLength(0);
    // 折叠容器本身常驻(高度过渡要有 0fr 起点),但没展开过的组不渲染任何内容
    expect(find(root, '.gal-fold-wrap')).toHaveLength(2);
    expect(find(root, '.gal-fold-body')).toHaveLength(0);
  });

  it('adds at most 24 images per click, handles the remainder and keeps folded groups loaded', async () => {
    const root = await mount();
    const [alphaHead, betaHead] = find(root, '.gal-fold-trigger');
    await click(alphaHead);
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, 'img').every(image => image.props.loading === 'lazy')).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
    expect(find(root, '.gal-more')[0].children.some(child => child.text.includes('5'))).toBe(true);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(53);
    expect(find(root, '.gal-more')).toHaveLength(0);

    // 收起只把高度归零,<img> 必须留在 DOM 里:重挂一次就是一张图一个网络往返
    // (/user/images 不带 maxAge,Firefox 更是 no-store),公网连 ST 时会白屏一拍。
    await click(alphaHead);
    expect(find(root, '.gal-fold-wrap')[0].props.class).toContain('is-collapsed');
    expect(find(root, 'img')).toHaveLength(53);
    await click(alphaHead);
    expect(find(root, '.gal-fold-wrap')[0].props.class).not.toContain('is-collapsed');
    expect(find(root, 'img')).toHaveLength(53);
    await click(betaHead);
    expect(find(root, 'img')).toHaveLength(58);
    expect(find(root, '.gal-more')).toHaveLength(0);
  });

  it('remembers manual expansion but resets batch sizes on remount and folds new groups', async () => {
    let root = await mount();
    await click(find(root, '.gal-fold-trigger')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(JSON.parse(stored.get(expandedKey)!)).toEqual([alpha]);

    vi.mocked(listUserImageFolders).mockResolvedValue([alpha, beta, `${prefix}Gamma`]);
    root = await mount();
    expect(find(root, 'img')).toHaveLength(24);
    expect(find(root, '.gal-fold-trigger').map(head => head.props['aria-expanded'])).toEqual([true, false, false]);
    await click(find(root, '.gal-fold-trigger')[0]);
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
    await click(find(root, '.gal-fold-trigger')[0]);
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);
  });

  it('does not open groups just because they match a search', async () => {
    const root = await mount();
    (find(root, 'input')[0].props['onUpdate:modelValue'] as (query: string) => void)('Beta');
    await nextTick();
    expect(find(root, '.gal-fold-trigger')).toHaveLength(1);
    expect(find(root, 'img')).toHaveLength(0);
    await click(find(root, '.gal-fold-trigger')[0]);
    expect(find(root, 'img')).toHaveLength(5);
  });
});

describe('gallery size readout disabled', () => {
  it('issues no HEAD probes and renders no size UI', async () => {
    const root = await mount();
    // 进页零体积探测;刷新也不该冒出来——请求数随图库线性增长正是暂时停用它的原因
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
    await click(find(root, '.gal-icon-btn')[0]);
    await flush();
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
    // 分组角标、总计体积、测量中的「+」一律不出现
    expect(find(root, '.gal-size')).toHaveLength(0);
    expect(find(root, '.gal-measuring')).toHaveLength(0);
    expect(text(find(root, '.gal-count')[0])).not.toContain('KB');
  });
});

describe('gallery multi-select delete', () => {
  /** 进入选择态并展开 Alpha。 */
  async function selectMode(): Promise<TestNode> {
    const root = await mount();
    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-fold-trigger')[0]);
    return root;
  }

  it('keeps thumbnails opening the lightbox until selection mode is on', async () => {
    const root = await mount();
    await click(find(root, '.gal-fold-trigger')[0]);
    expect(find(root, '.gal-check')).toHaveLength(0);
    await click(find(root, '.gal-thumb')[0]);
    await flush();
    expect(vi.mocked(openLightbox)).toHaveBeenCalledTimes(1);

    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-thumb')[0]);
    await flush();
    // 选择态下点图只勾选,不再放大
    expect(vi.mocked(openLightbox)).toHaveBeenCalledTimes(1);
    expect(find(root, '.gal-thumb')[0].props.class).toContain('is-selected');
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
  });

  it('removes the selected images from the gallery without resetting the expanded batch', async () => {
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-thumb')[2]);
    // 先把 Alpha 翻到第二批:删除后不能把用户翻出来的批次重置回 24 张
    await click(find(root, '.gal-more')[0]);
    expect(find(root, 'img')).toHaveLength(48);

    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();

    expect(vi.mocked(deleteImageFileOnly).mock.calls.map(call => call[0])).toEqual([
      keyOf(alpha, 'image-0.png'),
      keyOf(alpha, 'image-2.png'),
    ]);
    // 就地摘除:53 → 51,保持已展开的批次。
    expect(find(root, '.gal-badge').map(text)).toEqual(['51', '5']);
    // 已显示张数(48)不变,后面的图往前补位——删两张不该让用户重新往下翻
    expect(find(root, 'img')).toHaveLength(48);
    expect(text(find(root, '.gal-count')[0])).toContain('56 张');
    // 楼层卡片据此立刻降级,不必等它自己 404
    expect(isImageMissing(`user/images/${alpha}/image-0.png`)).toBe(true);
    expect(isImageMissing(`user/images/${alpha}/image-1.png`)).toBe(false);
    // 选中项清空后自动退出选择态
    expect(find(root, '.gal-actionbar')).toHaveLength(0);
  });

  it('selects the whole group from the header checkbox, not just the rendered batch', async () => {
    const root = await selectMode();
    expect(find(root, 'img')).toHaveLength(24);
    await change(find(root, '.gal-group-check')[0].children[0]);
    // 懒加载只渲染了 24 张,但「全选这个角色」指的是这个角色的全部 53 张
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('53');

    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();
    expect(vi.mocked(deleteImageFileOnly)).toHaveBeenCalledTimes(53);
    // 删空的分组整组消失
    expect(find(root, '.gal-fold-trigger')).toHaveLength(1);
    expect(text(find(root, '.gal-count')[0])).toContain('1 位角色');
  });

  it('keeps the files when the confirmation is declined', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();
    expect(vi.mocked(deleteImageFileOnly)).not.toHaveBeenCalled();
    // 取消不该顺手把选中项清掉:用户多半是想再核对一遍
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
    expect(find(root, '.gal-badge').map(text)).toEqual(['53', '5']);
  });

  it('keeps failed deletions selected and reports them instead of pretending they went', async () => {
    vi.mocked(deleteImageFileOnly).mockImplementation(async path => {
      if (path.endsWith('image-1.png')) throw new Error('EBUSY');
    });
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-thumb')[1]);
    await click(find(root, '.bbi-btn-danger')[0]);
    await flush();

    // 成功的摘掉、失败的留在列表里且仍勾着,用户可以直接重试
    expect(find(root, '.gal-badge').map(text)).toEqual(['52', '5']);
    expect(isImageMissing(`user/images/${alpha}/image-0.png`)).toBe(true);
    expect(isImageMissing(`user/images/${alpha}/image-1.png`)).toBe(false);
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('1');
    expect(toastr.error).toHaveBeenCalled();
    expect(toastr.success).not.toHaveBeenCalled();
  });

  it('drops the selection when leaving selection mode', async () => {
    const root = await selectMode();
    await click(find(root, '.gal-thumb')[0]);
    await click(find(root, '.gal-select-toggle')[0]);
    await click(find(root, '.gal-select-toggle')[0]);
    // 留着上次的选中项,下次进来会对着一批不记得为何选中的图按删除
    expect(text(find(root, '.gal-actionbar-count')[0])).toContain('0');
    expect(find(root, '.gal-thumb')[0].props.class).not.toContain('is-selected');
  });

});

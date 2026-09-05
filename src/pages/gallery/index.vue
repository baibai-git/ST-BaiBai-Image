<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { imageDownloadFileName } from '@/floor/download';
import { openLightbox } from '@/floor/lightbox';
import { readStore, sidecarPathFor, type BbiImageSidecar } from '@/floor/storage';
import { getContext } from '@/st/context';
import { formatPromptText, parseImageTagContent } from '@/st/imageTagRegex';
import { ARTIST_PREVIEW_FOLDER, listUserImageFolders, listUserImages } from '@/st/images';
import { computed, onMounted, ref } from 'vue';

/**
 * 图库页 —— 按角色名分组浏览已生成的图片（GALLERY-STORAGE-DESIGN.md）。
 *
 * 分组键取**目录名**而非文件名:落盘文件名里的角色名是哈希
 * (floor/storage.ts imageFileName,防中文名被清洗成连续下划线),可读名只能从
 * `user/images/柏宝绘_<角色名>/` 的目录名还原。
 *
 * 只读视图:点图放大、看提示词、另存。这里**不做删除**——图片路径同时被聊天记录
 * message.extra.bbiImage 引用,在图库删文件会给楼层卡片留下指向 404 的破指针;
 * 删图仍走楼层卡片/灯箱那条会同步清指针的路径。
 *
 * 提示词从两处取(见 promptFor):当前聊天的 extra 直接读,其余靠存图时写下的侧写 json。
 */

const FOLDER_PREFIX = '柏宝绘_';
/** 展开后先渲染一批,每次再追加一批,不一次铺开整个目录。 */
const PREVIEW_COUNT = 24;
/** 侧写请求超时:点图后要等它才开灯箱,不能让服务端卡住把点击拖成「点了没反应」。 */
const SIDECAR_TIMEOUT_MS = 4000;

interface GalleryImage {
  /** 目录内的文件名(组内唯一,作 key) */
  file: string;
  /** 归一化的完整路径,提示词缓存的键(跨目录唯一) */
  key: string;
  /** <img src>,已按段编码 */
  src: string;
  /** 另存文件名 */
  download: string;
}

interface GalleryGroup {
  /** 完整目录名(含前缀) */
  folder: string;
  /** 展示用角色名(去前缀) */
  name: string;
  images: GalleryImage[];
}

const groups = ref<GalleryGroup[]>([]);
const loading = ref(false);
const error = ref('');
/** 部分目录读取失败的条数:整页不失败,但要如实说明少了几组。 */
const partialFailed = ref(0);
const query = ref('');

/**
 * 静态路由 /user/images/* 服务端做 decodeURIComponent(users.js createRouteHandler),
 * 故逐段编码:中文名浏览器本会自动编码,但角色名里的 # ? 不编码会被当成 URL 片段/查询。
 */
function imageSrc(folder: string, file: string): string {
  return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/**
 * 归一化图片路径,给「聊天记录里的 path」与「图库拼出来的 src」找一个能相等的写法。
 *
 * 两边天生不一样:extra 里的 entry.path 是服务端 clientRelativePath 原样返回的**未编码**
 * 中文路径,而 imageSrc() 是逐段 encodeURIComponent 过的;前导斜杠也有无不定
 * (storage.ts 删除分支的 `/^\/?user\/images\//` 就是为此写的)。
 * 统一解码 + 去前导斜杠后再比。
 */
function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* 半截百分号编码:解不开就按原文比,总好过抛错 */
  }
  return decoded.replace(/^\/+/, '');
}

/** 从 bbi_<nameHash>_<swipe>_<promptHash>-<genId>.<ext> 里取 genId,取不到则回退原文件名。 */
function downloadName(characterName: string, file: string): string {
  const genId = file.match(/-([^-.]+)\.[a-z0-9]+$/i)?.[1];
  return genId ? imageDownloadFileName(file, characterName, genId) : file;
}

/* —— 提示词:当前聊天直接读 extra,其余走侧写 —— */

/**
 * 归一化路径 → 提示词全文。两个来源合用一张表:
 * - load() 时从**当前聊天**的 extra 预填(零网络开销,让本聊天的存量老图也有提示词);
 * - 点图未命中时取侧写 json 回填。
 * 取不到的记 null 并留在表里,免得反复点同一张图反复打 404。
 */
const promptCache = ref(new Map<string, string | null>());

/** 侧写/extra 里存的都是 tag 原文,统一在这里解析成人读的全文(与卡片同一口径)。 */
function renderPrompt(rawTag: string, seed: number | null): string {
  const text = formatPromptText(parseImageTagContent(rawTag));
  if (!text) return '';
  return seed === null ? text : `${text}\n\nSeed: ${seed}`;
}

/**
 * 扫当前聊天的 extra,把 path → 提示词全部收进缓存。
 *
 * 只扫当前这一个聊天:跨全库反查提示词曾评估过,单个角色的 chats 目录就能到 GB 级、
 * 且 /api/chats/get 整文件返回无分页,扫下去必然卡死。本聊天已在内存里,白拿。
 */
function seedPromptsFromChat(): void {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return;
  const next = new Map(promptCache.value);
  for (const message of chat) {
    const store = readStore(message);
    if (!store) continue;
    for (const bucket of Object.values(store)) {
      for (const list of Object.values(bucket)) {
        for (const entry of list) {
          if (!entry?.path || !entry.prompt) continue;
          next.set(normalizePath(entry.path), renderPrompt(entry.prompt, entry.seed ?? null));
        }
      }
    }
  }
  promptCache.value = next;
}

/**
 * 取侧写 json。走裸 fetch 不带 headers——静态路由不需要鉴权头
 * (与 backends/vibeStore.ts loadVibeData 同款)。
 * 任何失败(404 / 超时 / 不是 JSON)都返回 null 静默降级:老图本来就没有侧写,
 * 那是预期内的常态,不该报错也不该拦住灯箱。
 */
async function fetchSidecarPrompt(imagePath: string): Promise<string | null> {
  const sidecar = sidecarPathFor(imagePath);
  if (!sidecar) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS);
  try {
    const response = await fetch(sidecar, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<BbiImageSidecar>;
    if (!data || typeof data.prompt !== 'string' || !data.prompt) return null;
    return renderPrompt(data.prompt, typeof data.seed === 'number' ? data.seed : null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  partialFailed.value = 0;
  // 刷新时重扫当前聊天:期间可能又生成了几张图,也可能切了聊天
  seedPromptsFromChat();
  try {
    // 只列 /folders 报上来的目录:/api/images/list 对不存在的目录会 mkdir,
    // 凭空猜名字会在 user/images 下攒出空文件夹。
    const folders = (await listUserImageFolders()).filter(
      folder => folder.startsWith(FOLDER_PREFIX) && folder !== ARTIST_PREVIEW_FOLDER,
    );
    const settled = await Promise.allSettled(
      folders.map(async folder => ({ folder, files: await listUserImages(folder) })),
    );

    const next: GalleryGroup[] = [];
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') {
        partialFailed.value++;
        console.warn('[柏宝绘] 读取图库目录失败', folders[i], result.reason);
        return;
      }
      const { folder, files } = result.value;
      if (!files.length) return; // 删空后的残留目录不占位
      const name = folder.slice(FOLDER_PREFIX.length) || '未命名角色';
      next.push({
        folder,
        name,
        images: files.map(file => ({
          file,
          key: `user/images/${folder}/${file}`,
          src: imageSrc(folder, file),
          download: downloadName(name, file),
        })),
      });
    });

    // 当前聊天角色排最前,其余按名字排序——刚生成的图不用翻着找。
    const current = getContext()?.name2?.trim() ?? '';
    const collator = new Intl.Collator('zh-Hans-CN');
    next.sort((a, b) => {
      const rank = Number(b.name === current) - Number(a.name === current);
      return rank || collator.compare(a.name, b.name);
    });
    groups.value = next;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value.filter(group => group.name.toLowerCase().includes(q));
});

const totalImages = computed(() => groups.value.reduce((n, g) => n + g.images.length, 0));

/* 默认折叠,仅记录手动展开的分组。旧 collapsed 列表不能反推哪些组是手动展开的。 */
const EXPANDED_KEY = 'bbi.ui.galleryExpanded.v1';

function loadExpanded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

const expanded = ref<Set<string>>(loadExpanded());

function toggleFold(folder: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(folder)) next.add(folder);
  expanded.value = next;
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

/* 已显示数量仅在本次页面内保留,收起后再展开无需从第一批重来。 */
const visibleCounts = ref(new Map<string, number>());

function visibleImages(group: GalleryGroup): GalleryImage[] {
  return group.images.slice(0, visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT);
}

function showMore(group: GalleryGroup): void {
  const count = visibleCounts.value.get(group.folder) ?? PREVIEW_COUNT;
  visibleCounts.value.set(group.folder, Math.min(count + PREVIEW_COUNT, group.images.length));
}

/** 正在取侧写的那张图(点击后到灯箱打开之间,给个转圈别让人以为没点上)。 */
const pending = ref('');

/**
 * 点图:先备好提示词再开灯箱。
 *
 * 必须**先 await 再 openLightbox**:灯箱是命令式 h() 渲染的一次性组件,
 * props 不是响应式的,晚到的提示词补不进去。
 */
async function open(image: GalleryImage): Promise<void> {
  let prompt = promptCache.value.get(image.key);
  if (prompt === undefined) {
    pending.value = image.key;
    try {
      prompt = await fetchSidecarPrompt(image.key);
      // null 也要落缓存:记住「这张确实没有」,免得每次点都再打一轮 404
      promptCache.value = new Map(promptCache.value).set(image.key, prompt);
    } finally {
      pending.value = '';
    }
  }
  openLightbox({ src: image.src, filename: image.download, prompt: prompt ?? '' });
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">图库</h2>
      <button class="gal-icon-btn" type="button" title="重新读取" :disabled="loading" @click="load">
        <Icon name="refresh" />
      </button>
    </div>
    <hr class="bbi-rule" />

    <!-- 工具条:只搜角色名(文件名是哈希,搜了没意义) -->
    <div class="gal-toolbar">
      <input v-model="query" class="bbi-input gal-search" placeholder="搜索角色名" />
      <span class="gal-count">{{ groups.length }} 位角色 · {{ totalImages }} 张</span>
    </div>

    <p v-if="partialFailed" class="gal-warn">
      有 {{ partialFailed }} 个角色目录读取失败，未在下方列出（详情见控制台）。
    </p>

    <!-- 读取中 / 出错 / 空 / 列表 -->
    <div v-if="loading && !groups.length" class="gal-state">
      <Icon name="refresh" :size="26" class="gal-spin" />
      <p class="gal-state-title">正在读取图库…</p>
    </div>

    <div v-else-if="error" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">读取失败</p>
      <p class="gal-state-hint">{{ error }}</p>
      <button class="bbi-btn bbi-btn-sm" type="button" @click="load"><Icon name="refresh" /> 重试</button>
    </div>

    <div v-else-if="!groups.length" class="gal-state">
      <Icon name="gallery" :size="34" />
      <p class="gal-state-title">还没有图片</p>
      <p class="gal-state-hint">在聊天里生成图片后，会按角色自动归类到这里。</p>
    </div>

    <p v-else-if="!filtered.length" class="gal-state-inline">没有匹配「{{ query }}」的角色。</p>

    <div v-else class="gal-groups">
      <section
        v-for="group in filtered"
        :key="group.folder"
        class="gal-group"
        :class="{ 'is-collapsed': !expanded.has(group.folder) }"
      >
        <button
          class="gal-fold-head"
          type="button"
          :aria-expanded="expanded.has(group.folder)"
          :title="expanded.has(group.folder) ? `收起${group.name}` : `展开${group.name}`"
          @click="toggleFold(group.folder)"
        >
          <Icon name="chevron" class="gal-caret" :class="{ 'is-collapsed': !expanded.has(group.folder) }" />
          <span class="gal-name">{{ group.name }}</span>
          <span class="gal-badge">{{ group.images.length }}</span>
        </button>

        <!-- v-if 真正卸载折叠组的图片;Transition 保留 grid 0fr/1fr 收展动画。 -->
        <Transition name="gal-fold">
          <div v-if="expanded.has(group.folder)" class="gal-fold-wrap">
            <div class="gal-fold-inner">
              <div class="gal-fold-body">
                <ul class="gal-grid">
                  <li v-for="image in visibleImages(group)" :key="image.file" class="gal-cell">
                    <button
                      class="gal-thumb"
                      :class="{ 'is-busy': pending === image.key }"
                      type="button"
                      :title="image.file"
                      @click="open(image)"
                    >
                      <img class="gal-img" :src="image.src" :alt="`${group.name} 的生成图`" loading="lazy" />
                    </button>
                  </li>
                </ul>
                <button
                  v-if="group.images.length > visibleImages(group).length"
                  class="bbi-btn bbi-btn-sm gal-more"
                  type="button"
                  @click="showMore(group)"
                >
                  <Icon name="plus" />
                  再显示 {{ Math.min(PREVIEW_COUNT, group.images.length - visibleImages(group).length) }} 张
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </section>
    </div>
  </section>
</template>

<style scoped>
/* —— 题首右侧刷新 —— */
.gal-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}
.gal-icon-btn:hover:not(:disabled) {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.gal-icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

/* —— 工具条 —— */
.gal-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.gal-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.gal-count {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.gal-warn {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
  font-size: 12px;
}

/* —— 空/错/载入态 —— */
.gal-state {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 80px 20px;
  color: var(--bbi-ink-soft);
  text-align: center;
}
.gal-state-title {
  margin: 0;
  font-size: 15px;
  color: var(--bbi-ink);
}
.gal-state-hint {
  margin: 0;
  max-width: 34em;
  font-size: 12.5px;
  word-break: break-word;
}
.gal-state-inline {
  margin: 0;
  padding: 40px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-muted);
}
.gal-spin {
  animation: gal-rotate 0.9s linear infinite;
  color: var(--bbi-accent);
}
@keyframes gal-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gal-spin {
    animation: none;
  }
}

/* —— 分组 —— */
/* —— 分组卡片 ——
   与设置页 .bbi-sections 同款节奏(gap 12px):每组一张有边框的卡,
   收起时仍是一条实体标题栏,不会塌成一行浮字。
   与角色页共用「无框折叠头」语汇的差别在于:那边组内是灰白表单,
   这边是彩色缩略图,不给围合就镇不住。 */
.gal-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gal-group {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  /* 刻意不写 gap:.gal-fold-wrap 收成 0fr 后 gap 仍然占位,
     加了边框就会在卡片底部露出一条死白。间距一律由各自的 padding 给。 */
}

/* 标题行整体可点:左箭头 + 角色名 + 张数(与角色管理页同款折叠语汇)。
   卡片化之后头部自带 padding 并撑满圆角,hover 有底色反馈。 */
.gal-fold-head {
  /* 必须是 flex 而非 inline-flex:.gal-group 已不是 flex 容器,inline 级元素会落在行盒里,
     底下凭空多出一截行高留白,把标题栏和内容顶开。 */
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 14px;
  border: 0;
  /* 展开时 body 紧贴在下方,头部只留上圆角;收起时头部就是整张卡,四角全圆。
     不能用 overflow:hidden 一刀切——那会裁掉缩略图的 hover 抬升与阴影。 */
  border-radius: var(--bbi-radius) var(--bbi-radius) 0 0;
  background: transparent;
  color: inherit;
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-radius 0.24s var(--bbi-ease);
}
.gal-fold-head:hover {
  background: var(--bbi-surface-2);
}
.gal-fold-head:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}
.gal-group.is-collapsed > .gal-fold-head {
  border-radius: var(--bbi-radius);
}
.gal-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition:
    transform 0.2s var(--bbi-ease),
    color 0.15s;
}
.gal-caret.is-collapsed {
  transform: rotate(-90deg);
}
.gal-fold-head:hover .gal-caret,
.gal-fold-head:focus-visible .gal-caret {
  color: var(--bbi-accent);
}
.gal-name {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbi-ink);
  word-break: break-word;
}
.gal-badge {
  flex: 0 0 auto;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}

.gal-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.gal-fold-enter-from,
.gal-fold-leave-to {
  grid-template-rows: 0fr;
}
@media (prefers-reduced-motion: reduce) {
  .gal-fold-wrap {
    transition: none;
  }
}
.gal-fold-inner {
  min-height: 0;
  overflow: hidden;
}
/* padding 与分隔线都放这一层:它是 inner 的子级,收起时随 0fr 一并被裁掉,
   不会像挂在 inner 上那样留下一截撑开的残高(同 Collapsible.vue)。
   左 padding 12px + .gal-grid 自身 2px = 14px,正好与标题栏箭头左缘对齐。 */
.gal-fold-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--bbi-line);
}

/* —— 缩略图网格 —— */
.gal-grid {
  list-style: none;
  margin: 0;
  padding: 2px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}
.gal-cell {
  min-width: 0;
}
.gal-thumb {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  cursor: zoom-in;
  overflow: hidden;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.gal-thumb:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.gal-thumb:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
/* 取侧写提示词的那一小会儿:降透明度示意「在忙」,不改布局免得网格抖动 */
.gal-thumb.is-busy {
  opacity: 0.55;
  cursor: progress;
}
/* 固定 3:4 竖构图:生图多为竖版,统一比例让整格网格对齐,溢出由 cover 裁切 */
.gal-img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}

.gal-more {
  align-self: center;
}

@media (max-width: 640px) {
  .gal-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .gal-name {
    font-size: 13px;
  }
}
</style>

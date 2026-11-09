<script setup lang="ts">
import { formatBytes } from '@/bytes';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { imageDownloadFileName } from '@/floor/download';
import { openLightbox } from '@/floor/lightbox';
import { markImagesMissing, normalizeImagePath } from '@/floor/missingImages';
import { deleteImageFileOnly, readStore, sidecarPathFor, type BbiImageSidecar } from '@/floor/storage';
import { formatGenerationMeta, type GenerationMeta } from '@/generationMeta';
import { mapLimit } from '@/pool';
import { getContext } from '@/st/context';
import { formatPromptText, parseImageTagContent } from '@/st/imageTagRegex';
import { ARTIST_PREVIEW_FOLDER, listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { computed, onMounted, ref } from 'vue';

/**
 * 图库页：按角色名分组，结果与侧写文件由 floor/storage.ts 管理。
 *
 * 分组键取**目录名**而非文件名:落盘文件名里的角色名是哈希
 * (floor/storage.ts imageFileName,防中文名被清洗成连续下划线),可读名只能从
 * `user/images/柏宝绘_<角色名>/` 的目录名还原。
 *
 * 【删除】支持多选删除,但**只删文件、不碰聊天记录**:图片路径同时被
 * message.extra.bbiImage 引用,而图库按目录列图、指针散在各个聊天里,两者之间没有反向
 * 索引(扫全库反查不可行,见 floor/storage.ts 顶部)。破指针由楼层卡片侧运行时降级兜底:
 * 卡片的 <img> @error 会确认 404 后把这张图记进 floor/missingImages.ts,翻页器与张数
 * 随即按存活口径重算,全删光则退回「生成图片」态。删完本页也会就地标记,免得用户
 * 切回聊天才发现。
 *
 * 提示词从两处取(见 promptFor):当前聊天的 extra 直接读,其余靠存图时写下的侧写 json。
 */

const FOLDER_PREFIX = '柏宝绘_';
/** 展开后先渲染一批,每次再追加一批,不一次铺开整个目录。 */
const PREVIEW_COUNT = 24;
/** 侧写请求超时:点图后要等它才开灯箱,不能让服务端卡住把点击拖成「点了没反应」。 */
const SIDECAR_TIMEOUT_MS = 4000;
/**
 * 批量请求(探体积、删图)的并发上限。
 * 不开大:ST 是单进程,几十个请求一起压过去会把用户自己的聊天卡住;
 * 公网连接下更明显。6 路够快又不至于霸占连接池。
 */
const REQUEST_CONCURRENCY = 6;
/** 体积攒够这么多张再推一次响应式更新(理由见 measureSizes)。 */
const SIZE_PUBLISH_BATCH = 12;

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

/** 侧写/extra 里存的都是 tag 原文,统一在这里解析成人读的全文(与卡片同一口径)。
 *  meta(画师串/vibe/采样参数)是只读溯源信息,追加在后面;它不在可编辑的 tag 文本里。 */
function renderPrompt(rawTag: string, seed: number | null, meta?: GenerationMeta): string {
  const text = formatPromptText(parseImageTagContent(rawTag));
  if (!text) return '';
  const lines = [text];
  if (seed !== null) lines.push(`Seed: ${seed}`);
  if (meta) lines.push(formatGenerationMeta(meta));
  return lines.filter(Boolean).join('\n\n');
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
          next.set(normalizeImagePath(entry.path), renderPrompt(entry.prompt, entry.seed ?? null, entry.meta));
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
    return renderPrompt(data.prompt, typeof data.seed === 'number' ? data.seed : null, data.meta);
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
    // ⚠ 暂时禁用分组体积统计:作者不满意当前方案——逐张 HEAD 读 Content-Length,
    // 请求数随图库规模线性增长,进一次图库就是几百上千个后台请求。
    // 体积相关的计算、模板、CSS 与测试全部原样保留,恢复时解注下面这一行即可。
    // void measureSizes(next);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* —— 体积统计(⚠ 暂时禁用:load() 里的 measureSizes 调用已注释,理由见该处) —— */

/**
 * 归一化路径 → 字节数。**逐张 HEAD 量出来的**。
 *
 * 为什么只能这样:`/api/images/list` 只返回文件名,既无 size 也无 mtime
 * (服务端 util.js getImages 只 map 出 dirent.name),没有任何现成接口报体积。
 * HEAD 走静态路由 res.sendFile,实测 1~2ms 且无 body——比缩略图本身(图库直接加载原图,
 * 一个组就是十几 MB)便宜得多。
 *
 * 不进 localStorage 缓存:文件可能被外部改动,缓存过期没法感知,而重量一遍也就几十个
 * HEAD。页面活着期间按路径缓存即可,刷新按钮会重量。
 */
const sizes = ref(new Map<string, number>());
/** 还在量体积的分组数:>0 时总计后面显示「计算中」,免得把半截数字当成最终值。 */
const measuring = ref(0);

/**
 * 后台量体积:限并发逐张 HEAD。**不 await、不阻塞首屏**——图已经能看了,
 * 体积是附加信息,慢慢填上来即可。
 *
 * 已量过的路径跳过(刷新时大部分图没变,只有新增的那几张要量)。
 *
 * 攒批发布而非逐张写回:groupSize 要遍历组内全部图才能算出合计,每量到一张就发布一次
 * 等于让每个分组把自己重算 n 遍——几千张图时是平方级空转。攒够一批再推一次,
 * 「慢慢填上来」的观感不变。
 */
async function measureSizes(list: GalleryGroup[]): Promise<void> {
  const pending = list.flatMap(group => group.images).filter(image => !sizes.value.has(image.key));
  if (!pending.length) return;
  measuring.value++;
  // 未发布的增量。发布时**合并进当前值**而非整份替换:连点两次刷新会有两轮
  // measureSizes 并行,各自持有快照替换会把对方量到的数抹掉。
  const buffered = new Map<string, number>();
  const publish = (): void => {
    if (!buffered.size) return;
    const next = new Map(sizes.value);
    for (const [key, size] of buffered) next.set(key, size);
    buffered.clear();
    sizes.value = next;
  };
  try {
    await mapLimit(pending, REQUEST_CONCURRENCY, async image => {
      const probe = await probeUserImage(image.src);
      // 只记确定的数:探不到(网络错误)就留空,由 groupSize 按「还没量全」处理
      if (probe?.exists && probe.size !== null) {
        buffered.set(image.key, probe.size);
        if (buffered.size >= SIZE_PUBLISH_BATCH) publish();
      }
    });
  } finally {
    publish();
    measuring.value--;
  }
}

/** 一组的体积合计与完整度。量全了才是准数,否则文案要带「≥」。 */
function groupSize(group: GalleryGroup): { bytes: number; complete: boolean } {
  let bytes = 0;
  let known = 0;
  for (const image of group.images) {
    const size = sizes.value.get(image.key);
    if (size === undefined) continue;
    bytes += size;
    known++;
  }
  return { bytes, complete: known === group.images.length };
}

/** 分组角标上的体积文案;一张都没量出来时返回空串(不显示,而非显示 0 B)。 */
function groupSizeText(group: GalleryGroup): string {
  const { bytes, complete } = groupSize(group);
  if (!bytes) return '';
  const text = formatBytes(bytes);
  return complete ? text : `≥ ${text}`;
}

const totalSizeText = computed(() => {
  let bytes = 0;
  for (const size of sizes.value.values()) bytes += size;
  return bytes ? formatBytes(bytes) : '';
});

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

/**
 * 已挂载过内容的分组。**只进不出**——收起不卸载,再展开时图还在,零请求。
 *
 * 折叠容器改为常驻后,若内容也无条件渲染,一进页就要挂满所有角色的图(默认全折叠),
 * 比卸载更糟;故用它兜底:没手动展开过的分组一张图都不渲染,展开后永久留在 DOM 里。
 */
const mounted = ref<Set<string>>(new Set(expanded.value));

function persistExpanded(next: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

function toggleFold(folder: string): void {
  const open = !expanded.value.has(folder);
  // 首次展开时才挂内容;之后收起不再卸载。
  // 不必分两帧「先挂内容、下一帧再展开」——.gal-fold-wrap 自页面加载起就常驻且停在 0fr,
  // 过渡的起点值早已落定,同帧插入内容不影响它从 0fr 过渡到 1fr。
  if (open) mounted.value = new Set(mounted.value).add(folder);

  const next = new Set(expanded.value);
  if (open) next.add(folder);
  else next.delete(folder);
  expanded.value = next;
  persistExpanded(next);
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

/* —— 多选删除 —— */

/**
 * 选择模式。独立开关而非「长按进入」:图库的主用途是浏览,点图=放大必须是默认行为;
 * 选择态下点图改为勾选,两种语义靠这个开关明确分开,不让用户在放大和勾选之间猜。
 */
const selecting = ref(false);
/** 已勾选的图(归一化路径 key,跨分组唯一)。 */
const selected = ref(new Set<string>());
const deleting = ref(false);

const selectedCount = computed(() => selected.value.size);

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  // 退出选择态一律清空:留着选中项,下次进来会对着一批不记得为何选中的图按删除
  if (!selecting.value) selected.value = new Set();
}

function toggleSelected(image: GalleryImage): void {
  const next = new Set(selected.value);
  if (next.has(image.key)) next.delete(image.key);
  else next.add(image.key);
  selected.value = next;
}

/** 本组是否整组选中(空组不算)。 */
function groupAllSelected(group: GalleryGroup): boolean {
  return group.images.length > 0 && group.images.every(image => selected.value.has(image.key));
}

function someSelected(group: GalleryGroup): boolean {
  return !groupAllSelected(group) && group.images.some(image => selected.value.has(image.key));
}

/**
 * 整组全选/取消。**作用于整组而非当前可见的那批**——懒加载只是渲染策略,
 * 用户说「全选这个角色」指的是这个角色的全部图片,不该因为没往下翻而少选。
 */
function toggleGroup(group: GalleryGroup): void {
  const next = new Set(selected.value);
  if (groupAllSelected(group)) group.images.forEach(image => next.delete(image.key));
  else group.images.forEach(image => next.add(image.key));
  selected.value = next;
}

/** 点图:选择态勾选,否则放大。 */
function onThumbClick(image: GalleryImage): void {
  if (selecting.value) toggleSelected(image);
  else void open(image);
}

/**
 * 删除选中的图。**只删文件,不碰聊天记录**(理由见文件顶部注释)。
 *
 * 删完做三件事:标记缺失(让本会话里已打开的楼层卡片立刻降级,不必等它自己 404)、
 * 就地从列表摘掉(不重新 load,免得把用户的展开态和已加载批次全重置)、清理体积缓存。
 */
async function deleteSelected(): Promise<void> {
  if (!selectedCount.value || deleting.value) return;
  const targets = groups.value
    .flatMap(group => group.images)
    .filter(image => selected.value.has(image.key));
  if (!targets.length) return;

  const ok = await confirmDialog({
    title: `删除 ${targets.length} 张图片`,
    text:
      `将从磁盘删除这 ${targets.length} 张图片及其提示词侧写文件，无法恢复。\n\n` +
      '聊天记录不会被改动：楼层卡片会显示「图片文件已删除」并退回可重新生成的状态。',
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;

  deleting.value = true;
  try {
    // 逐张容错:一张失败不该中断其余的(mapLimit 会 reject 整体,故在回调里自己接住)
    const results = await mapLimit(targets, REQUEST_CONCURRENCY, async image => {
      try {
        // 传 key 而非 src:src 是给 <img> 用的逐段编码路径,而删除接口要的是解码后的
        // 磁盘路径(ST /api/images/delete 直接 path.join,不做 decodeURIComponent)。
        // key 与 markImagesMissing / sizes 同一口径,中文目录名不会打偏到 404。
        await deleteImageFileOnly(image.key);
        return { key: image.key, ok: true };
      } catch (e) {
        console.warn('[柏宝绘] 删除图片失败', image.key, e);
        return { key: image.key, ok: false };
      }
    });

    const done = new Set(results.filter(r => r.ok).map(r => r.key));
    const failed = results.length - done.size;

    if (done.size) {
      // 已打开的楼层卡片据此立刻降级(key 本就是归一化路径,与 missingImages 同口径)
      markImagesMissing(done);
      // 就地摘除:不 load(),否则用户的展开态与已加载批次全被重置
      groups.value = groups.value
        .map(group => ({ ...group, images: group.images.filter(image => !done.has(image.key)) }))
        .filter(group => group.images.length > 0);
      const nextSizes = new Map(sizes.value);
      done.forEach(key => nextSizes.delete(key));
      sizes.value = nextSizes;
    }

    selected.value = new Set([...selected.value].filter(key => !done.has(key)));
    if (!selected.value.size) selecting.value = false;

    if (failed) toastr.error(`${failed} 张删除失败，详情见控制台`, '柏宝绘');
    else toastr.success(`已删除 ${done.size} 张图片`, '柏宝绘');
  } finally {
    deleting.value = false;
  }
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
      <button
        class="bbi-btn bbi-btn-sm gal-select-toggle"
        :class="{ 'is-on': selecting }"
        type="button"
        :disabled="!groups.length"
        :title="selecting ? '退出选择' : '选择图片以批量删除'"
        @click="toggleSelecting"
      >
        <Icon :name="selecting ? 'close' : 'checklist'" />
        {{ selecting ? '退出选择' : '选择' }}
      </button>
      <span class="gal-count">
        {{ groups.length }} 位角色 · {{ totalImages }} 张<template v-if="totalSizeText">
          · {{ totalSizeText }}<span v-if="measuring" class="gal-measuring">+</span>
        </template>
      </span>
    </div>

    <!-- 选择态操作条:紧跟工具条、sticky 吸顶。
         放这里而非列表末尾:呼出它的「选择」钮就在上一行,一按就看见(摆到底部的话,
         角色多时按下去屏幕上什么都不动,像没生效);吸顶又保证往下翻多久都还在。 -->
    <div v-if="selecting" class="gal-actionbar">
      <span class="gal-actionbar-count">已选 {{ selectedCount }} 张</span>
      <button
        class="bbi-btn bbi-btn-sm"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="selected = new Set()"
      >
        清空
      </button>
      <button
        class="bbi-btn bbi-btn-sm bbi-btn-danger"
        type="button"
        :disabled="!selectedCount || deleting"
        @click="deleteSelected"
      >
        <Icon name="trash" />
        {{ deleting ? '删除中…' : '删除' }}
      </button>
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
        <!-- 标题行是「一个容器 + 内部若干独立控件」而非单个大按钮:选择态要在这一行里
             放整组全选的复选框,而 <button> 里不能嵌 <button>/<input>(HTML 非法且
             点击会双触发)。故折叠触发器单独是一颗按钮,复选框与它并排。 -->
        <div class="gal-fold-head">
          <label v-if="selecting" class="gal-group-check" :title="`全选${group.name}`">
            <input
              type="checkbox"
              class="bbi-checkbox"
              :checked="groupAllSelected(group)"
              :indeterminate="someSelected(group)"
              :aria-label="`全选${group.name}`"
              @change="toggleGroup(group)"
            />
          </label>
          <button
            class="gal-fold-trigger"
            type="button"
            :aria-expanded="expanded.has(group.folder)"
            :title="expanded.has(group.folder) ? `收起${group.name}` : `展开${group.name}`"
            @click="toggleFold(group.folder)"
          >
            <Icon name="chevron" class="gal-caret" :class="{ 'is-collapsed': !expanded.has(group.folder) }" />
            <span class="gal-name">{{ group.name }}</span>
            <span class="gal-badge">{{ group.images.length }}</span>
            <span v-if="groupSizeText(group)" class="gal-size">{{ groupSizeText(group) }}</span>
          </button>
        </div>

        <!-- 折叠容器常驻 DOM(grid 1fr→0fr 只把高度归零),<img> 不卸载:
             /user/images 静态路由 sendFile 不带 maxAge,默认 Cache-Control: max-age=0,
             重挂一次就是一张图一个条件请求(Firefox 更是 no-store,整份重下)。
             公网连 ST 时这些往返全压在延迟上,收起再展开会白屏一拍。同 floor/card.css。 -->
        <div class="gal-fold-wrap" :class="{ 'is-collapsed': !expanded.has(group.folder) }">
          <div class="gal-fold-inner">
            <div v-if="mounted.has(group.folder)" class="gal-fold-body">
              <ul class="gal-grid">
                <li v-for="image in visibleImages(group)" :key="image.file" class="gal-cell">
                  <button
                    class="gal-thumb"
                    :class="{
                      'is-busy': pending === image.key,
                      'is-selectable': selecting,
                      'is-selected': selecting && selected.has(image.key),
                    }"
                    type="button"
                    :title="selecting ? image.file : `放大 ${image.file}`"
                    :aria-pressed="selecting ? selected.has(image.key) : undefined"
                    @click="onThumbClick(image)"
                  >
                    <img class="gal-img" :src="image.src" :alt="`${group.name} 的生成图`" loading="lazy" />
                    <!-- 勾选角标:只在选择态出现,选中时填充主色 -->
                    <span v-if="selecting" class="gal-check" aria-hidden="true">
                      <Icon v-if="selected.has(image.key)" name="check" :size="13" />
                    </span>
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
/* 体积还在量:总计后跟一个「+」示意「至少这么多,还在加」。
   不用转圈——工具条里多一个动效太吵,而这个加号静态也读得懂。 */
.gal-measuring {
  margin-left: 1px;
  opacity: 0.6;
}

/* 选择模式开关。开启时用主色实心,与「正在选」的状态对齐。 */
.gal-select-toggle {
  flex: 0 0 auto;
}
.gal-select-toggle.is-on {
  border-color: var(--bbi-accent);
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
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
  font-size: 16px;
  color: var(--bbi-ink);
}
.gal-state-hint {
  margin: 0;
  max-width: 34em;
  font-size: 12px;
  word-break: break-word;
}
.gal-state-inline {
  margin: 0;
  padding: 40px 16px;
  text-align: center;
  font-size: 14px;
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
   卡片化之后头部自带 padding 并撑满圆角,hover 有底色反馈。
   选择态下这一行还要放整组全选的复选框,故外层是普通 div、折叠触发器是内部那颗按钮
   (<button> 里嵌 <input type=checkbox> 是非法嵌套,点击会双触发)。 */
.gal-fold-head {
  display: flex;
  align-items: center;
  /* 圆角与 hover 底色仍由本层给:它才是撑满卡片宽度的那一层 */
  border-radius: var(--bbi-radius) var(--bbi-radius) 0 0;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-head:hover {
  background: var(--bbi-surface-2);
}
/* 折叠触发器:占满标题行剩余宽度,自己不画背景(底色在父层,连复选框一起变) */
.gal-fold-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 11px 14px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font-family: var(--bbi-font-sans);
  text-align: left;
  cursor: pointer;
}
.gal-fold-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: -2px;
}
/* 复选框在最左侧,与触发器共享这一行的 hover 底色;
   padding 只给左右,高度靠标题行自身撑开,免得比触发器矮一截。
   尺寸/配色一律由全局 .bbi-checkbox 给,这里只清 margin——
   粉彩主题把 .bbi-checkbox 改成了自绘(背景勾 14px 居中),自己再改小会把勾挤到边上。 */
.gal-group-check {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  flex: 0 0 auto;
  padding: 0 2px 0 12px;
  cursor: pointer;
}
.gal-group-check .bbi-checkbox {
  margin: 0;
}
/* 有复选框时触发器的左 padding 收窄,免得箭头被推得太靠右 */
.gal-group-check + .gal-fold-trigger {
  padding-left: 8px;
}
/* 圆角只在两端瞬时切换,不参与过渡:收起中途的「下两角正在变圆」会让 .gal-fold-body
   那条满宽 border-top 的线头戳出圆角外(hover 有底色时尤其明显)。
   展开时立刻恢复直角(0s 无延迟),收起时等高度收完再变圆(0s + --bbi-dur 延迟)。 */
.gal-group.is-collapsed > .gal-fold-head {
  border-radius: var(--bbi-radius);
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-radius 0s var(--bbi-dur);
}
.gal-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition:
    transform var(--bbi-dur) var(--bbi-ease),
    color 0.15s;
}
.gal-caret.is-collapsed {
  transform: rotate(-90deg);
}
.gal-fold-trigger:hover .gal-caret,
.gal-fold-trigger:focus-visible .gal-caret {
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
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
}
/* 体积:跟在张数角标右边,不给底色——它是附注不是标签,压过角色名就喧宾夺主了。
   margin-left:auto 把它推到行尾,与右侧留白对齐。 */
.gal-size {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 8px;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gal-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbi-dur) var(--bbi-ease);
}
.gal-fold-wrap.is-collapsed {
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
/* 选择态:光标改指针(点击不再是放大),选中时主色描边 + 轻微内缩示意「被拿起」 */
.gal-thumb.is-selectable {
  cursor: pointer;
  position: relative;
}
.gal-thumb.is-selected {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 2px var(--bbi-accent) inset;
}
.gal-thumb.is-selected .gal-img {
  opacity: 0.72;
}
/* 勾选角标:右上角圆形。未选中时是半透明底的空圈(提示「这里可以点选」),
   选中后填主色显白勾。 */
.gal-check {
  position: absolute;
  top: 5px;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  border: 1.5px solid var(--bbi-surface);
  border-radius: 50%;
  background: var(--bbi-overlay);
  color: #fff;
}
.gal-thumb.is-selected .gal-check {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
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

/* —— 选择态操作条 ——
   紧跟工具条 + sticky 吸顶:呼出它的「选择」钮就在上一行,一按就看见;
   往下翻多久它都还在,不用滚回顶部才能删。
   top 给 calc(-1 * pad):滚动容器是 .bbi-body,它有 --bbi-page-pad 的内边距,
   滚动视口顶边落在内边距处;top:0 会让操作条停在内边距下沿、上方露出一条缝
   让缩略图从那里滚过去。抵消掉内边距才贴齐真实顶边(同 base.css 的 .bbi-modal-head)。 */
.gal-actionbar {
  position: sticky;
  top: calc(-1 * var(--bbi-page-pad));
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  /* 不透明底:下面是缩略图网格,半透明会把图透上来,数字读不清 */
  background: var(--bbi-surface);
  box-shadow: 0 6px 18px -14px var(--bbi-overlay);
}
.gal-actionbar-count {
  flex: 1 1 auto;
  font-size: 12px;
  color: var(--bbi-ink-soft);
  font-variant-numeric: tabular-nums;
}
/* .bbi-btn-danger 只声明在 ConfirmDialog 的 scoped 块里(base.css 没有),
   本组件要用就得把 base 与 hover 两条整份复制过来——只补 hover 的话平时是默认墨色、
   鼠标一过才变红,静态截图完全看不出问题。 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover:not(:disabled) {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .gal-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .gal-name {
    font-size: 14px;
  }
}
</style>

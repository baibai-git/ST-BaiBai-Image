<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { cancelFloorTags, requestFloorTags } from '@/autoTag/runner';
import type { ComicLayout } from '@/backends/mossLayout';
import { effectiveOrientation, type Orientation } from '@/backends/size';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { backendStatus, decideSeed, generateImage, tagBlockReason } from '@/generate';
import { consumeAutoGenerate, shouldAutoGenerate } from '@/floor/autoGenerate';
import { isCollapsed, setCollapsed } from '@/floor/collapseState';
import { imageDownloadFileName, saveImageFile } from '@/floor/download';
import {
  beginGen,
  cancelGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  reconcileGen,
  setGenPhase,
  setGenRetry,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';
import { hydrateMessage } from '@/floor/hydrate';
import { openLightbox } from '@/floor/lightbox';
import { confirmImageMissing, isImageMissing } from '@/floor/missingImages';
import { openPromptEditor } from '@/floor/promptEditor';
import {
  deleteImageResult,
  promptHash,
  saveImageResult,
  type BbiImageEntry,
} from '@/floor/storage';
import { isTagPlanning } from '@/floor/tagPlanState';
import { formatGenerationMeta } from '@/generationMeta';
import { activeComfyPreset, activeNaiPlan, activeOrientationLock, imageDisplayMaxHeight, settings, type ComfyKind } from '@/state/settings';
import { beginImage, failImage, finishImage, safeHistory } from '@/state/history';
import { copyText } from '@/st/clipboard';
import { getContext } from '@/st/context';
import { formatPromptText } from '@/st/imageTagRegex';

/**
 * 楼层生图卡片(DESIGN-FLOOR-UI.md §8)。
 *
 * 【重要】本组件是**纯展示层**,不持有运行态。
 * 卡片的生命周期由外部水合决定:任一槽位出图成功都会 hydrateMessage 重水合,
 * 而重水合卸载**整楼**卡片;ST 重渲染楼层时锚点 DOM 也会重建。
 * 运行态(生成中/错误/在途请求)一律存 floor/genState.ts 的模块级 store,按槽位 key 认领,
 * 组件重建后立刻读回——否则会出现「一张图完成,其余卡片的『生成中…』集体消失并退回 pending」
 * (标记已消费,不会自动重跑)。改这里前先读 genState.ts 顶部注释。
 *
 * 展示态分两层:
 * - 运行态(store):queued / generating / error —— 跨重建存活;
 * - 派生态(props):ready(有本提示词历史)/ stale(仅有旧提示词结果)/ pending —— 每次由 props 算出。
 */

const props = defineProps<{
  /** tag 原文解析出的 tag 部分(danbooru 短 tag;展示与生成用)。 */
  prompt: string;
  /** tag 原文解析出的自然语言部分(无则空串;生成时写入 %nl% 占位符)。 */
  nl: string;
  /** tag 原文解析出的动态负面部分(无则空串;生成时写入 %negative_prompt% 占位符)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 画幅方向(模型判定,随 tag 持久化):决定用渠道配置里的竖屏还是横屏尺寸;渠道锁了横竖时以锁为准(见 effectiveSize)。 */
  size: Orientation;
  /** tag 类型(<type> 子标签;缺省即插画)。 */
  kind: ComfyKind;
  /** 漫画分镜(kind 为 comic 时;解析不了 = null,卡片报「格式损坏」不出图)。插画恒为 null。 */
  layout: ComicLayout | null;
  /** tag 原文(含 <bbi_image> 壳):生成提交与 promptHash 的输入。 */
  tag: string;
  messageId: number;
  seq: number;
  swipeId: number;
  /** 当前提示词同槽位的全部历史(时间正序,最新在末尾)。 */
  history: BbiImageEntry[];
  /** 无匹配历史时,旧提示词同槽位的最新结果(stale)。 */
  staleEntry: BbiImageEntry | null;
  /** 所在聊天 id(水合时传入):槽位 key 的一部分,不再各自去 getContext 取。 */
  chatId: string;
}>();

type Phase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const key = computed(() => slotKey(props.chatId, props.messageId, props.swipeId, props.seq));
const hash = computed(() => promptHash(props.tag));

/**
 * 文件仍在的那部分历史。**卡片一律用它,不用 props.history**。
 *
 * 图库现在能直接删 user/images 下的文件,而那张图的指针还留在本楼的 extra 里
 * (图库按目录列图、指针在某个聊天里,两者无反向索引,扫全库反查不可行——
 * 见 floor/missingImages.ts 顶部)。破指针不过滤掉的话:翻页器会多出翻得到却是空的格子,
 * 折叠条的「N 张」也跟着虚高。
 *
 * 过滤只看**已确认 404**的图(missingImages 册),不是猜的:没被标记的图一律当作还在。
 */
const liveHistory = computed(() => props.history.filter(entry => !isImageMissing(entry.path)));
/** 旧提示词结果同样要对账:它的文件一样可能被图库删掉。 */
const liveStale = computed(() =>
  props.staleEntry && !isImageMissing(props.staleEntry.path) ? props.staleEntry : null,
);

/** 翻页位置:默认最新一张。history 变化(新图落盘 / 删掉破指针)后自动跟到最新。 */
const index = ref(liveHistory.value.length ? liveHistory.value.length - 1 : 0);
watch(
  () => liveHistory.value.length,
  length => {
    // 删掉的若是当前这张,index 会越界 → 钳回最后一张;新图落盘则跟到最新
    index.value = length ? length - 1 : 0;
  },
);

const promptOpen = ref(false);

/**
 * 折叠态:存模块级 store 按槽位 key 认领(组件随时被水合重建,ref 会丢),
 * 未手动设置过的槽位回落到设置项「楼层图片默认折叠」。见 floor/collapseState.ts。
 */
const collapsed = computed<boolean>({
  get: () => isCollapsed(key.value, settings.ui.autoCollapseImages),
  set: value => setCollapsed(key.value, value),
});

/** 触屏收纳菜单(⋯ 钮)的展开态;桌面 hover 一排直达,不用它。 */
const menuOpen = ref(false);

/**
 * 沉浸显示(设置项 ui.immersiveImages):有图时 ⋯ 与翻页器都藏起来,点一下图才浮现。
 * 只在有图时生效——无图时占位区本就是操作区(生成按钮等),藏了反而没处点。
 * 浮现态是本组件的临时 ref,不进 store:被重水合重建就回到藏起,正合「沉浸」的默认。
 */
const immersive = computed(() => settings.ui.immersiveImages && !!imageSrc.value);
const uiRevealed = ref(false);
/** 控件此刻是否藏着(给 CSS 的 data-hide-ui)。⋯ 菜单展开时必然算浮现。 */
const uiHidden = computed(() => immersive.value && !uiRevealed.value && !menuOpen.value);

/** 点图:沉浸且控件藏着 → 先把控件叫出来;否则照旧进灯箱。 */
function onImageClick(): void {
  if (uiHidden.value) {
    uiRevealed.value = true;
    return;
  }
  openImage();
}

const rootEl = ref<HTMLElement | null>(null);

/**
 * 点卡片外任意处收起控件。卡片挂在锚点的 open shadow root 里,composedPath 能穿进去,
 * 直接比 path 而不用 contains(contains 不跨 shadow 边界)。
 * 捕获阶段监听:ST 有些按钮会 stopPropagation,冒泡阶段收不到。
 */
function onOutsidePointerDown(event: PointerEvent): void {
  if (rootEl.value && event.composedPath().includes(rootEl.value)) return;
  uiRevealed.value = false;
  menuOpen.value = false;
}

// 只在浮现期间挂监听:一屏几十张卡片,不该每张都常驻一个全局 pointerdown
watch(uiRevealed, revealed => {
  if (revealed) document.addEventListener('pointerdown', onOutsidePointerDown, true);
  else document.removeEventListener('pointerdown', onOutsidePointerDown, true);
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointerDown, true));

/** 运行态记录(可能为 undefined = 无在途任务)。 */
const record = computed(() => getGenRecord(key.value));

/**
 * 「AI 重写提示词」的请求在途(模块级 store,见 floor/tagPlanState.ts)。
 * 与出图运行态刻意分开:它跑的是 LLM 请求,取消/并发语义与出图各自独立。
 */
const planning = computed(() => isTagPlanning(key.value));

const phase = computed<Phase>(() => {
  const running = record.value;
  if (running) return running.phase;
  // 用存活口径:图被图库删光后该退回 pending 给出「生成图片」入口,
  // 而不是顶着 ready 显示一张破图(那样连重新生成都点不了)。
  if (liveHistory.value.length) return 'ready';
  if (liveStale.value) return 'stale';
  return 'pending';
});

const error = computed(() => record.value?.error ?? '');
const queueAhead = computed(() => record.value?.queueAhead ?? null);
/** 限流退避中(NAI 自动重试);非 null 时状态文案优先报它。 */
const retryInfo = computed(() => record.value?.retry ?? null);

const comfyActive = computed(() => settings.defaultBackend === 'comfyui');
const naiActive = computed(() => settings.defaultBackend === 'nai');
/**
 * 后端是否已配齐(决定给「生成图片」按钮还是配置引导)。
 * 判据在 generate.ts 的 backendStatus 里,与真正出图、与公开接口同源——
 * 曾经这里自己判一套,改了 ComfyUI 简易模式的校验就得两处同步改。
 */
const configured = computed(() => backendStatus().configured);
/**
 * 这条 tag 与当前方案对不上(插画 tag 遇上漫画方案、或反过来),或漫画分镜已损坏:
 * 非空即禁用生成,并给「按当前方案重新生成本楼」入口。判据在 generate.ts(有单测)。
 */
const blockReason = computed(() => tagBlockReason({ kind: props.kind, layout: props.layout }));
/** 现在能不能出图:后端配齐且 tag 类型对得上。 */
const canGenerate = computed(() => configured.value && !blockReason.value);

/**
 * 实际出图方向:当前渠道锁了横竖就按锁(settings.ts 的 activeOrientationLock),否则按 tag 里记的。
 * generate.ts 出图时本就会按锁改写;这里再算一遍,是让历史记录与无图占位的比例跟真正出的图
 * 一致——否则锁了横屏,占位还按 tag 里的竖屏留出一大块。tag 原文不改(改了 promptHash 就变)。
 */
const effectiveSize = computed(() => effectiveOrientation(activeOrientationLock(), props.size));

/**
 * 设置项「楼层图片显示大小」:图片显示高度上限(px;null = 铺满楼层宽度,0.3.0 及以前的样子)。
 * 只经 data-capped + CSS 变量交给 card.css 处理,不量图片尺寸。
 */
const displayMaxHeight = computed(() => imageDisplayMaxHeight(settings.ui.imageDisplaySize));

const current = computed(() => liveHistory.value[index.value] ?? null);
/** 提示词全文:复制、灯箱、展开区共用。口径与图库同源(st/imageTagRegex.ts)。 */
const promptText = computed(() =>
  formatPromptText({
    tag: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters,
    kind: props.kind,
    layout: props.layout,
  }),
);
/**
 * 当前展示的结果。**刻意不看运行态**:生成失败/重绘中都该继续显示上一张图,
 * 否则「有图 → 点重绘 → 失败」会让图凭空消失(只剩一行报错),看着像把图弄丢了。
 */
const shownEntry = computed(() => (liveHistory.value.length ? current.value : liveStale.value));
const imageSrc = computed(() => shownEntry.value?.path ?? '');
/**
 * 灯箱展示用:提示词 + 只读元信息(画师串/vibe/采样参数)。
 * 与卡片内可编辑的 `promptText` 分开 —— 元信息只读,绝不能混进可写回的 tag 文本。
 */
const lightboxPrompt = computed(() => {
  const meta = shownEntry.value?.meta;
  return [promptText.value, meta ? formatGenerationMeta(meta) : ''].filter(Boolean).join('\n\n');
});

/**
 * `<img>` 加载失败:确认确实是 404 再落册,让上面那些 live* 把它摘掉。
 *
 * 不一 error 就当删除——error 分不清「文件没了」和「网断了」(详见 missingImages.ts)。
 * 确认失败时什么都不做:破图占位留着,下次重挂 <img> 会自然重试。
 */
async function onImageError(): Promise<void> {
  const path = imageSrc.value;
  if (!path) return;
  await confirmImageMissing(path);
}
const downloadFileName = (entry: BbiImageEntry): string => {
  const context = getContext();
  const characterName = context?.chat[props.messageId]?.name || context?.name2 || '';
  return imageDownloadFileName(entry.path, characterName, entry.generationId);
};
/** 展示的图是否属于旧提示词(有旧结果但当前提示词还没出过图)。 */
const isStale = computed(() => !liveHistory.value.length && !!liveStale.value);
/** 生成中/排队中仍显示上一张(若有),避免卡片塌空;骨架叠在其上。 */
const busy = computed(() => phase.value === 'generating' || phase.value === 'queued');
/** 历史翻页:多于一张且不忙才给(按存活张数,破指针不占格)。 */
const pageable = computed(() => liveHistory.value.length > 1 && !busy.value && !planning.value);

/** 有过结果、但文件已被删光(通常是在图库里删的)。据此给一句说明,免得像凭空丢图。 */
const filesGone = computed(
  () =>
    !busy.value &&
    !liveHistory.value.length &&
    !liveStale.value &&
    !!(props.history.length || props.staleEntry),
);

const statusLabel = computed(() => {
  // 退避优先:请求已经失败过、正在等重试,不能继续报「生成中」骗人
  const retry = retryInfo.value;
  if (retry) return `请求受限,稍后第 ${retry.attempt}/${retry.max} 次重试…`;
  if (phase.value === 'queued') return '排队中…';
  const ahead = queueAhead.value;
  if (phase.value === 'generating' && ahead !== null && ahead > 0) return `排队中(前面 ${ahead} 个)`;
  return '生成中…';
});

/** 折叠条主文案:生成中报进度;出错报原因;有图给提示词摘要(区分同楼多图);空槽位显示待生成。 */
const barText = computed(() => {
  if (planning.value) return 'AI 重写提示词…';
  if (busy.value) return statusLabel.value;
  if (phase.value === 'error') return error.value || '生成失败';
  if (shownEntry.value) return props.kind === 'comic' ? props.layout?.summary || '漫画' : props.prompt || props.nl || '图片';
  if (filesGone.value) return '图片文件已删除';
  return '待生成';
});

/** 无图且后端未就绪时,占位区中央的配置引导。 */
const pendingHint = computed(() => {
  if (!comfyActive.value && !naiActive.value)
    return '出图后端未选择,请到柏宝绘「渠道」页选择出图渠道';
  return naiActive.value
    ? '未配置 NAI,请到柏宝绘「渠道」页填写 API Key'
    : '未配置 ComfyUI,请到柏宝绘「渠道」页填写工作流';
});

async function generate(): Promise<void> {
  if (busy.value || planning.value || !canGenerate.value) return;
  const slot = key.value;
  const currentHash = hash.value;
  // 本次任务的输入全部就地取值:请求在途时本组件很可能已被重水合销毁
  // (任一兄弟槽位出图都会触发全楼重建),销毁后再读 props 不可靠。
  const job = {
    messageId: props.messageId,
    swipeId: props.swipeId,
    seq: props.seq,
    tag: props.tag,
    prompt: props.prompt,
    nl: props.nl,
    negative: props.negative,
    characters: props.characters.map(character => ({ ...character })),
    size: effectiveSize.value,
    // 深拷贝:分镜在途期间本组件可能已被重水合销毁
    comic: props.kind === 'comic' && props.layout ? (JSON.parse(JSON.stringify(props.layout)) as ComicLayout) : undefined,
  };
  // 漫画没有 tag,历史里记人读形态的分镜,回溯时才看得出画的是哪一页
  const historyPrompt = job.comic ? promptText.value : job.prompt;
  // NAI 需要闸门排队 → 先显示「排队中」;ComfyUI 有服务端队列,直接进 generating
  const { signal, token } = beginGen(slot, currentHash, naiActive.value ? 'queued' : 'generating');
  // 历史记录 id:在 seed 确定后才登记(见下),故这里先置空,catch 里据此判断要不要收尾。
  let historyId: number | null = null;

  try {
    // 发起时就确定种子(NAI 方案种子 > 0 时用固定值;否则随机),随结果落盘进 extra
    // (entry.seed),历史翻页可查/可复用。口径在 generate.ts,与公开接口同源。
    const seed = decideSeed(settings.defaultBackend);
    // 历史埋点:seed 已定、请求将发,此刻登记。图片本身不进 store(dataURL 会爆内存,
    // 且图随后就落盘进 ST 了)——只留元信息 + 楼层坐标,够回溯「这张图是怎么来的」。
    historyId = safeHistory(() =>
      beginImage({
        backend: naiActive.value ? 'nai' : 'comfyui',
        model: naiActive.value ? activeNaiPlan().model : activeComfyPreset().name,
        prompt: historyPrompt,
        nl: job.nl,
        negative: job.negative,
        characters: job.characters,
        seed,
        size: job.size,
        floor: job.messageId,
        seq: job.seq,
      }),
    );
    // 闸门、后端分派都在 generateImage 里(公开接口走同一条路,见 generate.ts);
    // 本组件只把进度回调接到自己的槽位运行态上。
    const { result, meta } = await generateImage({ ...job, seed }, signal, {
      onStart: () => setGenPhase(slot, token, 'generating'),
      onQueue: ahead => setQueueAhead(slot, token, ahead),
      onRetry: retry => setGenRetry(slot, token, retry),
    });
    // 图已经拿到手:此时若发现本任务已被取代(取消后重绘 / reconcile),不要落盘,
    // 否则会把旧提示词的结果写进 extra,并触发一次多余的重水合打断新任务。
    if (!isCurrentGen(slot, token)) {
      result.revoke();
      // 图出来了却被丢弃,历史里记成「已取消」——否则这条会永远停在「进行中」。
      if (historyId !== null) safeHistory(() => failImage(historyId!, '', true));
      return;
    }
    // 落盘:图片进 ST 文件系统 + extra 写指针。成功后重水合,
    // 卡片从 extra 恢复为 ready(blob/dataURL 生命周期随之结束)。
    await saveImageResult(job.messageId, job.swipeId, job.seq, job.tag, seed, result, meta);
    result.revoke();
    if (historyId !== null) safeHistory(() => finishImage(historyId!));
    // 先清运行态再重水合:重水合会重建本组件,清完才不会带着 generating 复活
    clearGen(slot, token);
    const ctx = getContext();
    if (ctx) hydrateMessage(job.messageId, ctx);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (historyId !== null) {
      safeHistory(() => failImage(historyId!, e instanceof Error ? e.message : String(e), aborted));
    }
    if (aborted) {
      clearGen(slot, token);
    } else {
      failGen(slot, token, e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * 「按当前方案重新生成本楼」:tag 类型与方案对不上时唯一的出路(见 blockReason)。
 * 与楼层按钮同一条路:剔除旧 tag → 按当前方案分析写入。请求归 runner,卡片随后会被重水合销毁。
 */
async function regenerateFloor(): Promise<void> {
  const floor = props.messageId;
  if (!settings.enabled) {
    toastr.warning('柏宝绘已停用，请先在插件设置里开启', '柏宝绘');
    return;
  }
  const ok = await confirmDialog({
    title: '按当前方案重新生成本楼',
    text: '会删除本楼全部生图 tag，再按当前出图方案重新分析写入；已生成的图片保留在卡片历史里，不会丢失。',
    confirmText: '重新生成',
  });
  if (!ok) return;
  await requestFloorTags(floor, { replace: true });
}

function cancel(): void {
  cancelGen(key.value);
}

function openImage(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  // 就地取值:灯箱挂在插件 shadow root,**活得比本卡片长**——任一兄弟槽位出图都会
  // 重水合销毁本组件,而灯箱还开着。回调里再读 props 就是读已销毁实例,故全部先快照。
  const at = { messageId: props.messageId, swipeId: props.swipeId };
  openLightbox({
    src: entry.path,
    prompt: lightboxPrompt.value,
    filename: downloadFileName(entry),
    onDelete: () => void removeEntry(entry, at),
  });
}

/**
 * 打开提示词编辑弹窗。与灯箱同一条纪律:弹窗挂插件 shadow root、**活得比本卡片长**,
 * 楼层坐标与内容一律先快照(任一兄弟槽位出图都会重水合销毁本组件)。
 * 提示词的真源是正文,故写回与后续重水合都在 promptEditor.ts 里做,本组件不参与。
 */
function openEditor(): void {
  openPromptEditor({
    at: {
      chatId: props.chatId,
      messageId: props.messageId,
      swipeId: props.swipeId,
      seq: props.seq,
      rawTag: props.tag,
    },
    content: {
      tag: props.prompt,
      nl: props.nl,
      negative: props.negative,
      characters: props.characters.map(character => ({ ...character })),
      size: props.size,
    },
    // 存活口径:文案要许诺「改回提示词即可找回」,被图库删掉的图找不回来,不能算进去
    historyCount: liveHistory.value.length,
    configured: configured.value,
    blockedReason: blockReason.value,
  });
}

/**
 * 取消在途的「AI 重写提示词」。
 *
 * 入口在提示词编辑弹窗里(floor/promptEditor.ts),不在卡片上 —— 手改与 AI 改是同一件事。
 * 但**请求不属于那个弹窗**:用户关掉弹窗后重写照跑,故卡片这边仍要显示进度并留取消口,
 * 否则关了窗就只剩一张悄悄变化的图、没处叫停。展示态读 tagPlanState,中止靠 runner
 * 的每楼请求锁。
 */
function cancelReplan(): void {
  cancelFloorTags(props.messageId);
}

/** 删除当前展示的这一条结果(DESIGN-FLOOR-UI.md §8.2)。 */function removeCurrent(): void {
  const target = shownEntry.value;
  if (!target) return;
  void removeEntry(target, { messageId: props.messageId, swipeId: props.swipeId });
}

/**
 * 删除一条结果。楼层坐标由调用方传入而非现场读 props:
 * 本函数可能在组件销毁后才真正执行(灯箱回调 + 确认弹窗都是异步的)。
 */
async function removeEntry(
  target: BbiImageEntry,
  at: { messageId: number; swipeId: number },
): Promise<void> {
  const ok = await confirmDialog({
    title: '删除这张图',
    text: '将删除这张图的聊天记录，无法恢复；images 中的文件会一并删除，files 中的旧图保留。同一提示词的其它历史结果不受影响。',
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;
  // stale 的图存在别的 hash 桶里,删除要用它自己的 promptHash,不能用当前 tag 的
  const bucketHash = promptHash(target.prompt);
  const removed = await deleteImageResult(
    at.messageId,
    at.swipeId,
    bucketHash,
    target.generationId,
  );
  if (!removed) {
    toastr.error('删除失败,聊天记录未能保存', '柏宝绘');
    return;
  }
  const ctx = getContext();
  if (ctx) hydrateMessage(at.messageId, ctx);
}

async function copyPrompt(): Promise<void> {
  await copyText(promptText.value, '提示词已复制');
}

/** 另存当前展示的这张图(与灯箱共用 download.ts,免得两份逻辑漂移)。 */
function downloadCurrent(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  saveImageFile(entry.path, downloadFileName(entry));
}

// 提示词变更对账放 watch 而非 onMounted:差分水合(hydrate.ts)下同锚点卡片是
// props patch 而非重挂,onMounted 不会再跑;tag 一变必须立刻作废旧提示词的任务。
watch(hash, current => reconcileGen(key.value, current), { immediate: true });

onMounted(() => {
  // 「写入 tag 后自动生成图片」:本槽位带着标记水合挂载 → 消费标记并直接开始生成。
  // **标记一律先消费再判断**:留着它会在日后同槽位重现(比如用户删掉旧图)时被新卡片
  // 误认领,凭空开跑一次用户没点过的生成。判定本身抽成 shouldAutoGenerate 纯函数
  // (本组件没有单测,留在这儿锁不住),口径见 floor/autoGenerate.ts。
  // 未配置后端时不跑(卡片维持 pending,显示配置引导);标记同样已消费掉。
  if (!props.chatId) return;
  const mode = consumeAutoGenerate(props.chatId, props.messageId, props.swipeId, props.seq);
  if (!mode) return;
  if (!shouldAutoGenerate(mode, phase.value)) return;
  // 类型对不上的 tag 静默跳过(卡片上自有提示与整楼重来的入口)
  if (!canGenerate.value) return;
  void generate();
});
</script>

<template>
  <!-- 沉浸式设计:图即卡片。无边框/无背景面板/无品牌栏,控件悬浮在图上,
       桌面 hover 浮现、触屏常驻淡显;提示词收进悬浮按钮唤起的面板,平时零占位。 -->
  <div
    ref="rootEl"
    class="bbi-figure"
    :data-phase="phase"
    :data-capped="displayMaxHeight ? '1' : ''"
    :style="displayMaxHeight ? { '--bbi-figure-max-h': `${displayMaxHeight}px` } : undefined"
  >
    <!-- 折叠态:收成一条细条,职责只有「占位 + 展开」——整条点击展开,
         生成中/出错在条上给状态但不放操作按钮(要操作先展开)。 -->
    <button
      v-if="collapsed"
      class="bbi-figure__bar"
      type="button"
      title="展开图片"
      @click="collapsed = false"
    >
      <span v-if="busy || planning" class="bbi-figure__bar-spin" aria-hidden="true" />
      <Icon v-else name="generate" :size="14" class="bbi-figure__bar-icon" />
      <span class="bbi-figure__bar-text" :data-error="phase === 'error' && !busy && !planning ? '1' : ''">
        {{ barText }}
      </span>
      <span v-if="liveHistory.length > 1 && !busy" class="bbi-figure__bar-count">
        {{ liveHistory.length }} 张
      </span>
      <Icon name="chevron" :size="13" class="bbi-figure__bar-chevron" />
    </button>

    <!-- 折叠容器:常驻 DOM(grid-template-rows 1fr→0fr 过渡做高度动画),折叠时只是
         高度归零 + 淡出,<img> 不卸载——展开瞬间图就在,不会重新发起请求。 -->
    <div class="bbi-figure__collapse" :data-collapsed="collapsed ? '1' : ''">
      <div class="bbi-figure__collapse-inner">
    <div
      class="bbi-figure__stage"
      :data-size="effectiveSize"
      :data-placeholder="imageSrc ? '' : '1'"
      :data-hide-ui="uiHidden ? '1' : ''"
    >
      <img
        v-if="imageSrc"
        class="bbi-figure__img"
        :src="imageSrc"
        alt="生图结果"
        @click="onImageClick"
        @error="onImageError"
      />

      <!-- 无图时的生成中:骨架微光扫过占位底 -->
      <div v-if="busy && !imageSrc" class="bbi-figure__skeleton" />

      <!-- 生成中遮罩:绝对定位盖在整个舞台上(有图=磨砂盖住旧图,无图=压住骨架)。
           居中 spinner + 状态 + 取消,不再像旧版那样作为 flex 子项跟图片并排互挤。 -->
      <div v-if="busy" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">{{ statusLabel }}</span>
        <button class="bbi-figure__cancel" type="button" @click="cancel">取消</button>
      </div>

      <!-- 提示词重写遮罩(AI 重写提示词):还是同一张图,只盖一层进度与取消;
           与出图遮罩互斥(replan/generate 的守卫保证两者不同时在途) -->
      <div v-else-if="planning" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">AI 重写提示词…</span>
        <button class="bbi-figure__cancel" type="button" @click="cancelReplan">取消</button>
      </div>

      <!-- 无图且空闲:生成入口 / 配置引导 -->
      <div v-if="!imageSrc && !busy" class="bbi-figure__pending">
        <template v-if="configured && blockReason">
          <p class="bbi-figure__hint">{{ blockReason }}</p>
          <button class="bbi-figure__generate" type="button" @click="regenerateFloor">
            <Icon name="refresh" :size="15" />
            按当前方案重新生成本楼
          </button>
        </template>
        <button v-else-if="configured" class="bbi-figure__generate" type="button" @click="generate">
          <Icon name="palette" :size="15" />
          {{ phase === 'error' ? '重试' : '生成图片' }}
        </button>
        <p v-else class="bbi-figure__hint">{{ pendingHint }}</p>
      </div>

      <!-- 提示词已改:角标提示,不再整图压暗 -->
      <span v-if="isStale && !busy && !planning" class="bbi-figure__badge">旧提示词</span>

      <!-- 悬浮操作组:⋯ 收纳钮钉在右上角常驻淡显;桌面 hover、触屏点开,菜单都在其左侧横向排开
           (窄图放不下就折行),点任意操作后自动收起(图片平时只有一颗小点) -->
      <span v-if="!busy && !planning" class="bbi-figure__actions" :data-open="menuOpen ? '1' : ''">
        <button
          class="bbi-fab bbi-figure__more"
          type="button"
          title="更多操作"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <Icon name="more" :size="15" />
        </button>
        <span class="bbi-figure__menu">
          <button
            class="bbi-fab"
            type="button"
            title="折叠图片"
            @click="menuOpen = false; collapsed = true"
          >
            <Icon name="chevron" :size="15" style="transform: rotate(180deg)" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            :disabled="!canGenerate"
            :title="canGenerate ? '重绘' : blockReason || '请先在柏宝绘「渠道」页完成配置'"
            @click="menuOpen = false; generate()"
          >
            <Icon name="refresh" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            title="下载这张图"
            @click="menuOpen = false; downloadCurrent()"
          >
            <Icon name="download" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab bbi-fab--danger"
            type="button"
            title="删除这张图"
            @click="menuOpen = false; removeCurrent()"
          >
            <Icon name="trash" :size="15" />
          </button>
          <!-- 漫画分镜不给手改:分格坐标手改不现实,改画面只走整楼重新生成 -->
          <button
            v-if="kind !== 'comic'"
            class="bbi-fab"
            type="button"
            title="编辑提示词"
            @click="menuOpen = false; openEditor()"
          >
            <Icon name="edit" :size="15" />
          </button>
          <button
            v-if="promptText"
            class="bbi-fab"
            :class="{ 'bbi-fab--on': promptOpen }"
            type="button"
            title="查看提示词"
            :aria-expanded="promptOpen"
            @click="menuOpen = false; promptOpen = !promptOpen"
          >
            <Icon name="text" :size="15" />
          </button>
        </span>
      </span>

      <!-- 翻页器:叠在图片右下角的胶囊 -->
      <span v-if="pageable" class="bbi-figure__pager">
        <button class="bbi-figure__pager-btn" type="button" :disabled="index <= 0" @click="index--">◀</button>
        <span class="bbi-figure__pager-count">{{ index + 1 }}/{{ liveHistory.length }}</span>
        <button
          class="bbi-figure__pager-btn"
          type="button"
          :disabled="index >= liveHistory.length - 1"
          @click="index++"
        >
          ▶
        </button>
      </span>
    </div>

    <!-- 状态行:仅出错 / 提示词已改时出现,平时零占位 -->
    <p v-if="phase === 'error'" class="bbi-figure__status bbi-figure__status--error">
      {{ error
      }}<button v-if="canGenerate" class="bbi-figure__retry" type="button" @click="generate">
        重试
      </button>
    </p>
    <!-- 有图但类型对不上(无图时提示在占位区里):旧图照看,新图只能整楼重来 -->
    <p v-else-if="configured && blockReason && imageSrc && !busy && !planning" class="bbi-figure__status bbi-figure__status--warn">
      {{ blockReason
      }}<button class="bbi-figure__retry" type="button" @click="regenerateFloor">
        按当前方案重新生成本楼
      </button>
    </p>
    <p v-else-if="isStale && !busy && !planning" class="bbi-figure__status bbi-figure__status--warn">
      提示词已修改,上图由旧提示词生成;点右上角重绘按新提示词出图
    </p>
    <!-- 文件被删(通常是在图库里删的):记录还在但图没了,明说一句免得像凭空丢图 -->
    <p v-else-if="filesGone" class="bbi-figure__status bbi-figure__status--warn">
      图片文件已删除(在图库里删掉了);可点上方重新生成
    </p>

    <!-- 提示词面板:悬浮 文本按钮唤起,复制按钮跟着面板走 -->
    <div v-if="promptOpen && promptText" class="bbi-figure__prompt-box">
      <pre class="bbi-figure__prompt">{{ promptText }}</pre>
      <button class="bbi-figure__prompt-copy" type="button" title="复制提示词" @click="copyPrompt">
        <Icon name="copy" :size="14" />
      </button>
    </div>
      </div>
    </div>
  </div>
</template>

import { h, render } from 'vue';

import PromptEditor from '@/floor/PromptEditor.vue';
import { cancelFloorTags, requestSlotTag } from '@/autoTag/runner';
import { markForAutoGenerate, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { awaitTagPlan, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';
import { slotKey } from '@/floor/genState';
import { confirmDialog } from '@/components/confirm';
import { getContext } from '@/st/context';
import {
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  type ImageTagContent,
} from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';

/**
 * 命令式打开「编辑提示词」弹窗(供楼层卡片调用)。
 *
 * 挂载位置与 components/confirm.ts、floor/lightbox.ts 同款:插件 host 的 shadow root ——
 * 那里有 dist/index.css 与 --bbi-* 主题变量,挂 document.body 会裸奔无样式。
 * 特意**不**挂进卡片自己的 shadow root:弹窗是 fixed 全屏层,而卡片活在 .mes_text 内部,
 * 那里的层叠上下文与 overflow 会把它裁掉(灯箱同理,见 lightbox.ts)。
 *
 * 【提示词的真源是正文】
 * tag 原文存在 message.mes 里,不在 extra、不在 store。所以「编辑提示词」本质是一次
 * 正文写回:序列化新 tag → 原位替换第 seq 条 → applyMessageText(身份 CAS)→
 * 重水合。新 tag 换出新 promptHash,老图自动落进 stale 桶(卡片已有「旧提示词」角标
 * 与提示行),故「应用」不需要任何额外落地逻辑。
 */

// 与 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

/** 楼层坐标快照。弹窗活得比卡片长,这些一律开窗时取值,回调里绝不读 props。 */
export interface PromptEditorAt {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  /** 开窗时的 tag 原文:写回前用它确认 seq 还指向同一条 tag。 */
  rawTag: string;
}

export interface PromptEditorOptions {
  at: PromptEditorAt;
  /** 解析出的原始内容(弹窗的初值与「有没有真的改」的基准)。 */
  content: ImageTagContent;
  /** 当前提示词下已有几张图。 */
  historyCount: number;
  /** 后端是否已配置好。 */
  configured: boolean;
  /** 这条 tag 不能用当前方案出图的原因(见 generate.ts 的 tagBlockReason);空 = 可以。 */
  blockedReason?: string;
}

/** 同一时刻只允许一个编辑弹窗,重复调用先关旧的。 */
let closeCurrent: (() => void) | null = null;

/** 离场动画时长,与 base.css 的 .bbi-modal-enter/leave-active(0.15s)对齐。 */
const LEAVE_MS = 160;

/** 补水合的延时,与 hydrate.ts 的 LATE_HYDRATION_DELAY 同一口径。 */
const LATE_HYDRATION_MS = 100;

/** 写回未成功时给用户的说法(exhaustive:新增 ApplyMessageResult 分支时这里会编译报错)。 */
function failureReason(result: Exclude<ApplyMessageResult, 'saved'>): string {
  switch (result) {
    case 'chat-changed':
      return '聊天已切换,提示词未保存';
    case 'floor-changed':
      return '楼层已变化,提示词未保存';
    case 'swipe-changed':
      return '已切换到别的 swipe,提示词未保存';
    case 'build-failed':
      return '正文里的这条 tag 已被改动,请关闭弹窗后重新编辑';
    case 'unavailable':
      return 'SillyTavern 上下文不可用,提示词未保存';
  }
}

/**
 * 写回正文。返回 true 表示已落盘。
 *
 * 失败一律 toast 并返回 false,**弹窗不关** —— 用户可能刚打了几十个 tag,
 * 因为切了个 swipe 就把草稿吞掉是不可接受的。
 */
async function writeBack(
  at: PromptEditorAt,
  content: ImageTagContent,
  regenerate: boolean,
): Promise<boolean> {
  const context = getContext();
  if (!context) {
    toastr.error('SillyTavern 上下文不可用', '柏宝绘');
    return false;
  }
  const message = context.chat?.[at.messageId];
  if (!message) {
    toastr.error('楼层已不存在,提示词未保存', '柏宝绘');
    return false;
  }

  const nextTag = serializeImageTag(content);
  // 标记必须挂在写回**之前**:写回即触发重水合、卡片挂载时消费标记(同 autoTag/runner.ts)。
  // force 模式无条件开跑 —— 用户点的就是「重新生成」,即便这条提示词以前出过图。
  if (regenerate) {
    markForAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq, 'force');
  }

  let result: Awaited<ReturnType<typeof applyMessageText>>;
  try {
    result = await applyMessageText(
      at.messageId,
      currentText => {
        // 弹窗可能开着好几分钟。身份 CAS 只认聊天/楼层/swipe,**刻意不比对正文内容**
        // (那是与别的改正文插件共存的关键),所以「tag 数变了 / 这条 tag 被别人改了」
        // 拦不住,只能在这里按原文自己核对:seq 指的还是不是同一条。
        if (parseImageTags(currentText)[at.seq] !== at.rawTag) return null;
        return replaceImageTagAt(currentText, at.seq, nextTag);
      },
      at.chatId,
      at.swipeId,
      message,
    );
  } catch (error) {
    // 撤销标记:只取回自己这一枚,不能用 clearAutoGenerateForFloor(会连累同楼兄弟槽位)
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
    return false;
  }

  if (result !== 'saved') {
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.warning(failureReason(result), '柏宝绘');
    return false;
  }

  // applyMessageText 内部会触发 MESSAGE_EDITED / MESSAGE_UPDATED,楼层通常已自行重水合;
  // 但 ST 编辑框开着时它走 settleActiveEditor 分支(**不发 MESSAGE_UPDATED**),没人来水合,
  // 故这里自己补。补两次的理由同 hydrate.ts 的 scheduleHydration:别的 ST 监听器可能在这之后
  // 才替换 .mes_text,晚班那次若锚点没变只是一次廉价 props patch(零重建、零重复消费标记)。
  hydrateMessage(at.messageId, context);
  setTimeout(() => {
    const later = getContext();
    if (!later || later.getCurrentChatId() !== at.chatId) return;
    hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
}

/**
 * 从正文里重读第 seq 条 tag,算出重写落盘后弹窗该换成什么(纯函数,便于单测)。
 *
 * 返回 null = 什么都别动:正文读不到、seq 已不存在、或原文压根没变。不猜、不兜底——
 * 正文是提示词的唯一真源(见文件头),读不出就该保留用户眼前的东西。
 *
 * **rawTag 与 content 必须一起换**:只换 content(回填了输入框)不换 rawTag,用户接着点
 * 「应用」会撞上「这条 tag 已被改动」,而改动它的正是我们自己触发的这次重写。
 */
export function nextEditorState(
  text: string | undefined,
  seq: number,
  currentRawTag: string,
): { rawTag: string; content: ImageTagContent } | null {
  if (typeof text !== 'string') return null;
  const nextRaw = parseImageTags(text)[seq];
  if (nextRaw === undefined || nextRaw === currentRawTag) return null;
  return { rawTag: nextRaw, content: parseImageTagContent(nextRaw) };
}

export function openPromptEditor(options: PromptEditorOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);
  let busy = false;
  /** 草稿是否已改动:由组件 emit('dirty') 推上来。 */
  let dirty = false;
  /** 已请求关闭:置上后重渲染一次让组件播离场动画,LEAVE_MS 后真卸载。 */
  let closing = false;
  /** 正在问「放弃修改?」:ConfirmDialog 自己不处理 Esc,而本弹窗的捕获监听还活着,
   *  不挡住的话连按 Esc 会叠出好几个确认框。 */
  let asking = false;
  /**
   * 弹窗当前展示的内容。AI 重写落盘后换成正文里的新版本,组件 watch 到即回填输入框。
   * 与 options.content 分开:那是开窗时的快照,不该被改。
   */
  let content: ImageTagContent = options.content;
  /**
   * 写回 CAS 用的 tag 原文。**重写落盘后必须换成新的** ——
   * 否则用户接着点「应用」会撞上「这条 tag 已被改动」,而改动它的正是我们自己。
   */
  let rawTag = options.at.rawTag;
  /**
   * 本窗内 AI 重写已经落过盘。弹窗不自动关,用户回头看到的是一份「已经存进正文」的提示词,
   * 与他自己手打、还没点应用的草稿长得一样 —— 不明说一句,没法分辨哪份已经生效。
   */
  let rewritten = false;
  /** 本槽位的运行态 key,与 genState / tagPlanState 同构。 */
  const planKey = slotKey(options.at.chatId, options.at.messageId, options.at.swipeId, options.at.seq);
  /**
   * 本窗已经关了(含被后来者顶掉)。**迟到的回调一律不准再渲染** ——
   * 重写跑在 tagPlanState 里、活得比弹窗长,它的收尾回调会在关窗之后才到。
   *
   * 这道闸门不是洁癖:容器虽已 remove,但 ModalMask 是 <Teleport> 到 modalHost 的,
   * **容器脱离文档并不等于看不见** —— 往脱档容器里 render 一次,弹窗会原地复活到屏幕上,
   * 而且复活的是全新实例(closing 的 watch 没有 immediate,顶着 closing=true 挂载也不会自行隐藏),
   * 随后 requestClose / onApply 又都在 closing 上早退 → 叉、取消、应用全部点不动,窗关不掉。
   */
  let closed = false;

  const close = () => {
    if (closeCurrent !== close) return; // 已被后来者替换,不重复清理
    closeCurrent = null;
    // 先让组件播离场动画(ModalMask 的 Transition 要求容器仍挂着),再真卸载
    closing = true;
    paint();
    setTimeout(() => {
      // 置 closed 必须在 render(null) **之前**:两者之间若插进一次迟到的 paint,
      // 卸载的就是刚被它重新挂上的那个实例,等于白关。
      closed = true;
      render(null, container);
      container.remove();
    }, LEAVE_MS);
  };
  closeCurrent = close;

  /**
   * 重写收尾后:从**当前正文**把这一槽的 tag 重新读一份,回填输入框。
   * 判定在 nextEditorState(纯函数,有单测),这里只负责取正文与赋值。
   * 返回 true = 确实换了新提示词(据此给一行「已保存」的说明)。
   */
  const refreshFromMessage = (): boolean => {
    const next = nextEditorState(
      getContext()?.chat?.[options.at.messageId]?.mes,
      options.at.seq,
      rawTag,
    );
    if (!next) return false;
    rawTag = next.rawTag;
    content = next.content;
    rewritten = true;
    return true;
  };

  /**
   * 真正发起重写。
   *
   * 跑在 tagPlanState 里而不是本弹窗里:**关掉弹窗不中断重写**(用户的明确要求)。
   * runner 自己会落盘并 force 出图,所以这里只负责收尾后把新提示词读回来、重绘。
   * 弹窗**不自动关**——点一下就闪退像是崩了。
   */
  const startRewrite = (): void => {
    if (busy || closing || isTagPlanning(planKey)) return;
    const task = runTagPlan(planKey, () => requestSlotTag(options.at.messageId, options.at.seq));
    paint();
    void task
      .catch(() => {
        // 失败原因 runner 已经 toast 过了,这里只负责把转圈停掉
      })
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  };

  /**
   * 「AI 重写提示词」按钮。
   *
   * 草稿改过就先问一句:重写是**真落盘**的,收尾后草稿必然被新提示词顶掉
   * (不顶掉更糟——用户接着点「应用」会拿旧草稿把刚重写的覆盖回去)。手打了半天被一次
   * 点击无声吞掉是丢数据,口径同 requestClose;共用 asking 挡住叠出好几个确认框。
   */
  const rewrite = (): void => {
    if (busy || asking || closing || isTagPlanning(planKey)) return;
    if (!dirty) {
      startRewrite();
      return;
    }
    asking = true;
    void confirmDialog({
      title: 'AI 重写提示词',
      text: '你手改的内容还没有应用。AI 重写完会直接保存，并把这些改动顶掉。',
      confirmText: '重写',
    }).then(ok => {
      asking = false;
      if (ok) startRewrite();
    });
  };

  // 重开弹窗时接上在途的重写:请求属于 store,关窗没有中断它。
  // 不重复发起,只等它收尾后照样回填(用户要的「续上」)。
  const rejoin = awaitTagPlan(planKey);
  if (rejoin) {
    void rejoin
      .catch(() => {})
      .finally(() => {
        refreshFromMessage();
        paint();
      });
  }

  /** 关窗请求:草稿改过就先问一句,免得手打半天被一下 Esc 吞掉。 */
  const requestClose = () => {
    if (busy || asking || closing) return;
    if (!dirty) {
      close();
      return;
    }
    asking = true;
    void confirmDialog({
      title: '放弃修改',
      text: '提示词的改动还没有应用,关闭后会丢失。',
      confirmText: '放弃',
      cancelText: '继续编辑',
      tone: 'danger',
    }).then(ok => {
      asking = false;
      if (ok) close();
    });
  };

  /**
   * 重渲染(props patch,组件实例与草稿都留着 —— 写回失败时用户不丢输入)。
   *
   * **不用 ref 拿组件实例**:命令式 render 没有父组件,`ref` 的 owner 为 null,
   * 挂载时 Vue 因 parentComponent 护栏静默跳过、卸载时无护栏直接抛
   * "Cannot read properties of null (reading 'refs')",且 ref 从未生效
   * → 拿不到实例 → 关不掉弹窗。状态一律走 props/emit。
   */
  const paint = () => {
    // 迟到的重绘一律丢弃(见 closed 的注释):容器已脱档,但 ModalMask 会 Teleport 出去,
    // 渲染进去等于把关掉的弹窗又贴回屏幕,且再也关不掉。
    if (closed) return;
    render(
      h(PromptEditor, {
        content,
        historyCount: options.historyCount,
        configured: options.configured,
        blockedReason: options.blockedReason ?? '',
        busy,
        rewriting: isTagPlanning(planKey),
        rewritten,
        closing,
        onDirty: (value: boolean) => {
          dirty = value;
        },
        onRewrite: rewrite,
        onCancelRewrite: () => cancelFloorTags(options.at.messageId),
        onApply: (value: ImageTagContent, regenerate: boolean) => {
          if (busy || closing) return;
          busy = true;
          paint();
          void writeBack({ ...options.at, rawTag }, value, regenerate).then(ok => {
            busy = false;
            if (ok) close();
            else paint();
          });
        },
        onClose: requestClose,
      }),
      container,
    );
  };
  paint();
}

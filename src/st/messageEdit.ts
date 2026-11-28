import { getContext, type STContext, type STMessage } from '@/st/context';

function findMessage(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function activeEditorText(floor: number): string | null {
  return findMessage(floor)?.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value ?? null;
}

function currentSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function setMessageText(message: STMessage, text: string): void {
  message.mes = text;
  const swipeId = currentSwipeId(message);
  if (swipeId === null || !message.swipes || swipeId < 0 || swipeId >= message.swipes.length) return;
  message.swipes[swipeId] = text;
}

function settleActiveEditor(floor: number, text: string): boolean {
  const message = findMessage(floor);
  const editor = message?.querySelector<HTMLTextAreaElement>('#curEditTextarea');
  if (!message || !editor) return false;

  editor.value = text;
  message.querySelector<HTMLElement>('.mes_edit_cancel')?.click();
  return true;
}

async function emitMessageEvent(context: STContext, event: string | undefined, floor: number): Promise<void> {
  if (event && context.eventSource.emit) await context.eventSource.emit(event, floor);
}

async function refreshRenderedMessage(context: STContext, message: STMessage, floor: number): Promise<void> {
  if (!findMessage(floor)) return;
  if (typeof context.updateMessageBlock === 'function') {
    try {
      await context.updateMessageBlock(floor, message);
      return;
    } catch {
      // 局部刷新失败时再退回整段聊天重载。
    }
  }
  await context.reloadCurrentChat?.();
}

export type ApplyMessageResult =
  | 'saved'
  | 'chat-changed'
  | 'floor-changed'
  | 'swipe-changed'
  | 'build-failed'
  | 'unavailable';

export interface MessageExtraUpdate {
  key: string;
  /** undefined = 删除该键。 */
  value: unknown;
}

interface ExtraOnlyEdit {
  extra: MessageExtraUpdate[];
}

/**
 * 判断槽位里的消息还是不是请求开始时那一条。
 *
 * 不用对象引用比对:别的插件改正文时常整体替换消息对象(chat[i] = {...chat[i], mes})，
 * 引用比对会把这种「同一条消息、只是换了个壳」误判成楼层变化,连带整次分析作废。
 * send_date 在消息创建时定死、编辑不变,配 name 足以认人;删楼导致索引平移时
 * send_date 必然不同,该拦的照样拦住。旧消息没有 send_date 时退回引用比对。
 */
export function isSameMessage(message: STMessage, expected: STMessage): boolean {
  if (message === expected) return true;
  if (!expected.send_date) return false;
  return message.send_date === expected.send_date && message.name === expected.name;
}

/**
 * 在聊天、楼层和重抽版本一致时修改正文或扩展数据。
 *
 * 身份检查(聊天 / 消息 / swipe)一致才落盘;正文内容本身**不**参与比对——正文由
 * buildNext 基于「落盘那一刻的真实正文」现算,别的插件在分析期间做的修改因此得以保留，
 * 而不是被请求开始时的旧快照覆盖。buildNext 返回 null 表示它认为这次不该写。
 * 保存失败时同时回滚正文与 extra，避免留下半写状态。
 */
export async function applyMessageText(
  floor: number,
  buildNext: (currentText: string, message: STMessage) => string | ExtraOnlyEdit | null,
  expectedChatId: string,
  expectedSwipeId: number | null,
  expectedMessage?: STMessage,
  extraUpdate?: MessageExtraUpdate,
): Promise<ApplyMessageResult> {
  const context = getContext();
  if (!context?.saveChat) return 'unavailable';
  if (context.getCurrentChatId?.() !== expectedChatId) return 'chat-changed';

  const message = context.chat?.[floor];
  if (!message) return 'unavailable';
  if (expectedMessage && !isSameMessage(message, expectedMessage)) return 'floor-changed';
  if (currentSwipeId(message) !== expectedSwipeId) return 'swipe-changed';

  // 编辑框开着时它才是正文的活口径(用户改了还没确认),落盘基底以它为准
  const change = buildNext(activeEditorText(floor) ?? message.mes, message);
  if (change === null) return 'build-failed';
  const writesText = typeof change === 'string';
  const updates = writesText ? (extraUpdate ? [extraUpdate] : []) : change.extra;

  const previousText = message.mes;
  const previousExtra = message.extra;
  const swipeId = currentSwipeId(message);
  const previousSwipeText = swipeId !== null ? message.swipes?.[swipeId] : undefined;
  const swipeInfo = !writesText && swipeId !== null ? message.swipe_info?.[swipeId] : undefined;
  const previousSwipeExtra = swipeInfo?.extra;
  const nextExtra = updates.length ? { ...previousExtra } : undefined;
  if (writesText) setMessageText(message, change);
  if (nextExtra) {
    for (const { key, value } of updates) {
      if (value === undefined) delete nextExtra[key];
      else nextExtra[key] = value;
    }
    message.extra = nextExtra;
    if (swipeInfo) swipeInfo.extra = nextExtra;
  }

  try {
    await context.saveChat();
  } catch (error) {
    if (writesText || (message.extra === nextExtra && currentSwipeId(message) === swipeId)) message.extra = previousExtra;
    if (swipeInfo && swipeInfo.extra === nextExtra) swipeInfo.extra = previousSwipeExtra;
    if (writesText) {
      message.mes = previousText;
      if (swipeId !== null && message.swipes && swipeId >= 0 && swipeId < message.swipes.length) {
        message.swipes[swipeId] = previousSwipeText ?? previousText;
      }
    }
    throw error;
  }

  if (!writesText) return 'saved';

  await emitMessageEvent(context, context.eventTypes.MESSAGE_EDITED, floor).catch(error => {
    console.warn('[柏宝绘] tag 已保存，但 MESSAGE_EDITED 事件发送失败', error);
  });
  if (!settleActiveEditor(floor, message.mes)) {
    await refreshRenderedMessage(context, message, floor).catch(error => {
      console.warn('[柏宝绘] tag 已保存，但楼层刷新失败', error);
    });
    await emitMessageEvent(context, context.eventTypes.MESSAGE_UPDATED, floor).catch(error => {
      console.warn('[柏宝绘] tag 已保存，但 MESSAGE_UPDATED 事件发送失败', error);
    });
  }
  return 'saved';
}

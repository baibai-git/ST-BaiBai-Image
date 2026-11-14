/**
 * NAI 并发闸门 + 节奏,**每个接入点一把**。
 *
 * 为什么只有 NAI 需要:两个后端的排队模型不同——
 * - ComfyUI:POST /prompt 拿到 prompt_id 即入**服务端**队列,轮询各查各的 history,
 *   一次性全发出去由 ComfyUI 自己顺序执行。客户端再加队列纯属多余,还白拖慢。
 * - NAI:generate-image 是一次阻塞式 POST,等到图出来才返回,没有队列概念。
 *   并发几个就是几条连接同时压过去,容易吃 429(见 backends/nai.ts 的错误映射)。
 *
 * 故闸门只包 NAI,上限用户可调(默认 1)。ComfyUI 路径不经过这里。
 *
 * 为什么按接入点分:限流是站/账号级的事。官方站与公益站各有各的额度与脾气(有的公益站
 * 允许并发 3,官方站一般只敢 1),一把全局闸门只能迁就最严的那个;更糟的是 A 站吃了 429,
 * 冷却会把走 B 站的方案也一起冻住。闸门键 = 接入点 id(settings.nai.endpoints[].id)。
 *
 * 闸门只管**同时几个**,管不了**多快一个**:release 后立刻 pump,下一个任务在同一个
 * tick 就发出去了。被限流时这会打出一串密集失败请求(429 → release → 立刻再来 → 429),
 * 恰恰最像滥用。故取到槽后还要等一段该闸门的节奏(相邻请求最小间隔 + 429 冷却),
 * 口径收在 backends/naiRateLimit.ts。
 */

import {
  abortableDelay,
  DEFAULT_NAI_GATE,
  naiPacingDelayMs,
  noteNaiRequestStart,
  resetNaiPacing,
} from '@/backends/naiRateLimit';

interface Gate {
  limit: number;
  running: number;
  /** 等待队列:先进先出,resolve 后拿到执行权。 */
  waiting: Array<() => void>;
}

const gates = new Map<string, Gate>();

/** 没设过上限的闸门按 1 起步:宁可慢,不在设置还没同步到时就并发压过去。 */
function gateOf(id: string): Gate {
  let gate = gates.get(id);
  if (!gate) {
    gate = { limit: 1, running: 0, waiting: [] };
    gates.set(id, gate);
  }
  return gate;
}

/** 设置某个接入点的并发上限(1 起步)。调大时立刻放行等待中的任务。 */
export function setNaiConcurrency(value: number, gateId: string = DEFAULT_NAI_GATE): void {
  const gate = gateOf(gateId);
  gate.limit = Math.max(1, Math.floor(value) || 1);
  pump(gate);
}

function pump(gate: Gate): void {
  while (gate.running < gate.limit && gate.waiting.length) {
    const next = gate.waiting.shift();
    if (!next) break;
    gate.running++;
    next();
  }
}

/**
 * 在某个接入点的闸门上取得一个执行槽。返回 release 函数,**必须**在 finally 里调用,
 * 否则闸门泄漏。signal 已取消时直接抛 AbortError,不占用槽位。
 *
 * 返回前还会等完该闸门的节奏(最小间隔 + 429 冷却),故调用方拿到 release 时即可立刻发请求。
 * 后续重试要用**同一个** gateId 记账(runNaiWithRetry 的 gate 选项)。
 */
export async function acquireNaiSlot(
  signal?: AbortSignal,
  gateId: string = DEFAULT_NAI_GATE,
): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');
  const gate = gateOf(gateId);

  if (gate.running < gate.limit) {
    gate.running++;
  } else {
    await new Promise<void>((resolve, reject) => {
      // 排队期间被取消:从队列摘除并抛错,不能让它之后还占一个槽
      const onAbort = () => {
        const index = gate.waiting.indexOf(grant);
        if (index >= 0) gate.waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      gate.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  let released = false;
  const release = () => {
    if (released) return; // 幂等:重复 release 不会把 running 减穿
    released = true;
    gate.running--;
    pump(gate);
  };

  // 节奏等待**持槽进行**,这是关键:若放在取槽之前,上限内的 N 个任务会一起等完同一段
  // 再一起发,节流形同虚设。持槽等待才能让第 N 个真正排在第 N-1 个之后。
  // 循环而非单次:等待期间别的槽位可能吃到 429 把冷却又推后了,醒来得重新问一次。
  try {
    for (let wait = naiPacingDelayMs(Date.now(), gateId); wait > 0; wait = naiPacingDelayMs(Date.now(), gateId)) {
      await abortableDelay(wait, signal);
    }
  } catch (error) {
    // 等待期间被取消:必须把槽还回去。漏一格就永久少一格并发,漏满就再也发不出请求。
    release();
    throw error;
  }
  noteNaiRequestStart(Date.now(), gateId);

  return release;
}

/** 某个接入点当前是否需要排队(用于卡片显示「排队中」而非「生成中」)。 */
export function naiSlotBusy(gateId: string = DEFAULT_NAI_GATE): boolean {
  const gate = gateOf(gateId);
  return gate.running >= gate.limit;
}

/** 测试用:复位所有闸门与节奏。放行(而非丢弃)等待者,避免遗留 promise 永挂。 */
export function resetNaiGate(): void {
  const pending = [...gates.values()].flatMap(gate => gate.waiting.splice(0, gate.waiting.length));
  gates.clear();
  resetNaiPacing();
  for (const grant of pending) grant();
}

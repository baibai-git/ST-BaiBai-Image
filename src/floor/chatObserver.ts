/**
 * `#chat` 子树变更的**唯一** MutationObserver。
 *
 * 为什么要共用一个:楼层按钮对账与卡片自愈盯的是同一棵树、同样的 childList+subtree。
 * 各自 new 一个 observer,浏览器就要把同一批 MutationRecord 收集两遍、派发两遍;
 * 而真正的开销在收集侧,不在回调侧。合成一个之后,新增一个订阅者的边际成本
 * 只是回调里多跑一个函数——这也是「加自愈会不会常驻卡顿」的答案:不会,因为
 * 这笔观察成本从楼层按钮上线那天起就已经在付了。
 *
 * 节流用 rAF:流式渲染期间 Mutation 极密(每个 token 一次),同一帧内的连续变更
 * 合并成一次回调。订阅者的回调必须是「便宜的对账」——只读属性、只在真有差异时
 * 才动 DOM,别在里面做全量重建。
 */

type ChatMutationListener = () => void;

const listeners = new Set<ChatMutationListener>();

let observer: MutationObserver | null = null;
let scheduled = false;

function flush(): void {
  scheduled = false;
  for (const listener of listeners) {
    // 一个订阅者抛异常不能连坐其它订阅者(尤其别让它把自愈整条链路带走)
    try {
      listener();
    } catch (error) {
      console.error('[柏宝绘] #chat 变更回调异常', error);
    }
  }
}

/**
 * 绑定观察器(幂等)。`#chat` 在 ST 静态模板里,取不到说明宿主环境异常,直接放弃。
 * 返回 false 时调用方**不该**自行退化成轮询:那比 observer 贵得多。
 */
export function ensureChatObserver(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;

  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  // 只要 childList+subtree:属性变更(/hide 翻 is_system、我们自己给锚点写 data-theme
  // 与内联样式)一律不进来。后者尤其关键——观察 attributes 会让自愈写属性的动作
  // 反过来唤醒自己,变成自激循环。
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}

/** 订阅 `#chat` 变更(自动确保观察器已绑定)。返回退订函数。 */
export function onChatMutation(listener: ChatMutationListener): () => void {
  listeners.add(listener);
  ensureChatObserver();
  return () => listeners.delete(listener);
}

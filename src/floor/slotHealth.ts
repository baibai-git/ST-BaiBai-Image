/**
 * 卡片「还活着吗」的判据(纯函数,便于单测)。
 *
 * 背景:锚点 `<div data-bbi-slot>` 活在楼层的 `.mes_text` **里面**,而 ST 自己有好几条
 * 路径会整体重写 `.mes_text`,其中相当一部分**不发任何事件**:
 * - `updateMessageBlock`(script.js) `.mes_text.html(...)`,无事件;
 * - `messageEditCancel` / `messageEditDone` 的 `.mes_text.empty()`;
 * - 右滑生成时 `.mes_text.html('...')`;
 * - 第三方插件(提示词模板类)在自己的渲染钩子里 `container.html(newContent)`。
 * 纯事件驱动的水合对这些一律无感:锚点连同 shadow root 一起被删,卡片就此消失,
 * 而 genState 是模块级的,在途生成照样跑完——用户看到的正是「图在生成,楼层里没界面」。
 *
 * 另一类是**没被删、但看不见**:`.mes_text.inline_media { display:none }`(style.css)。
 * 只要本楼 `extra.media` 非空且 `extra.inline_image === false`,ST 就给 `.mes_text`
 * 挂上 `inline_media`,把整段正文(连我们的卡片)一起隐藏。原生出图扩展与打标扩展
 * 都会写这个组合。这种情况锚点在、shadowRoot 在,重挂多少次都没用。
 *
 * 故判据分两种,处置也不同:
 * - `detached`:锚点脱离文档 → 重新水合本楼(重建锚点关系并重挂卡片);
 * - `hidden-by-host`:锚点在、但祖先被宿主 CSS 隐藏 → 重挂无用,得解除隐藏。
 */

/** 单个已挂载槽位的体检结论。 */
export type SlotHealth = 'ok' | 'detached' | 'hidden-by-host';

/**
 * 宿主把 `.mes_text` 整段隐藏时挂的 class(style.css 里 `display:none`)。
 * 只认这一个:用户自己写的美化 CSS 千奇百怪,穷举不了,靠 host 上的 `display` 兜底
 * (见 pinHostDisplay)。
 */
export const HOST_HIDE_CLASS = 'inline_media';

/**
 * 体检一个锚点。`host` 传锚点元素本身(即 shadow root 的宿主)。
 *
 * 注意顺序:先判 detached。脱离文档的元素 `closest()` 仍能沿着已断开的子树往上走、
 * 也可能真找到带 class 的 `.mes_text`(整段被 ST 换下来的那份),若先判 hidden
 * 就会把「已经被删掉的楼」误报成「被隐藏」,于是既不重挂、又去改一个不在文档里的
 * 节点的 class,卡片永远回不来。
 */
export function checkSlotHealth(host: Element | null | undefined): SlotHealth {
  if (!host || !host.isConnected) return 'detached';
  const mesText = host.closest('.mes_text');
  if (mesText?.classList.contains(HOST_HIDE_CLASS)) return 'hidden-by-host';
  return 'ok';
}

/**
 * 从锚点找出它所属的楼层号(`.mes[mesid]`)。找不到返回 null。
 * 自愈只重挂**受影响的那一楼**,不做全量重建——全量重建会对每条消息跑
 * parseImageTags + readStore + promptHash,放在 rAF 回调里就是真卡顿。
 */
export function floorIdOf(host: Element | null | undefined): number | null {
  const mes = host?.closest('.mes');
  const raw = mes?.getAttribute('mesid');
  // 空串/纯空白必须先挡掉:Number('') 与 Number(' ') 都是 0,会把「mesid 缺失的
  // .mes 外壳」当成第 0 楼,于是自愈去重水合一个毫不相干的楼层。
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

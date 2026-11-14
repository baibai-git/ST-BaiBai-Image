# 柏宝绘公开接口（API v1）

本文面向 SillyTavern 插件、脚本和预设作者。柏宝绘把两件事开放给外部调用：

1. **读角色库** —— 拿到柏宝绘已记录的角色和可直接出图的 tag
2. **调生图** —— 让柏宝绘出一张图，**图显示在哪里由你决定**

入口只有一个 JavaScript 全局对象：`globalThis.STBaiBaiImage`。

## 这个接口解决什么

柏宝绘自己的图是画在**楼层正文**里的（消息下方的卡片）。有些插件不想要这种呈现——想画在侧边栏、画在自己的弹窗里、画完直接当立绘用。这个接口给的就是这个：柏宝绘负责出图（后端配置、并发闸门、限流退避、落盘归档全都复用），你负责显示。

**生成的图不会进入任何聊天记录。** 它不出现在楼层正文里，不占楼层卡片，也不写 `message.extra`。默认只会存进柏宝绘图库（见 `save`）。

## 兼容约定

- `apiVersion` 当前固定为 `1`。它是**公开数据结构**的版本，与插件自身的 `pluginVersion` 分开——后者天天涨，前者不涨。请按 `apiVersion` 判兼容，不要去解析 `pluginVersion` 的语义。
- 结构只增不改不删：新增可选字段是安全的；改字段含义或删字段一律会升 `apiVersion`。
- 所有返回值都是**普通可克隆对象**的深拷贝：不含函数、不含 Vue 响应式代理、不含类实例。你怎么改返回值都不会影响柏宝绘。
- 楼层编号统一使用 SillyTavern 的零基 `mesid`。
- **错误请按 `error.code` 分支判断**，不要匹配 `message` 文案（中文、会随版本改），也不要用 `instanceof`（跨插件 bundle 边界一律失效）。

## 等待接口就绪

插件加载顺序不固定，两条路都要写：

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) {
    callback(globalThis.STBaiBaiImage);
    return;
  }
  window.addEventListener(
    'st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage),
    { once: true },
  );
}
```

就绪后可检查能力：

```js
const api = globalThis.STBaiBaiImage;

console.log(api.apiVersion);     // 1
console.log(api.pluginVersion);  // 柏宝绘插件版本
console.log(api.capabilities);
// { globalApi: true, characterLibrary: true, generate: true, saveToGallery: true, events: true }
```

## 读角色库

```js
const list = globalThis.STBaiBaiImage.getCharacters();

for (const character of list.characters) {
  console.log(character.name, character.tag);
}
```

返回结构：

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  revision: 7,          // 角色库每变一次 +1，拿它做缓存失效
  floor: null,          // 快照对应的楼层；null = 当前
  characters: [
    {
      name: "阿黛尔",
      // 可直接拿去出图的完整 tag 串 —— 推荐直接用这个
      tag: "1girl, short silver hair, blue eyes, pale skin, slender, scar on left eyebrow, black coat",
      // 分字段版本（要自己挑着用时才需要）
      fields: {
        fandom: "",     // 同人身份
        sex: "1girl",
        hair: "short silver hair",
        eyes: "blue eyes",
        skin: "pale skin",
        body: "slender",
        extra: "scar on left eyebrow",  // 标志特征
        outfit: "black coat",
      },
      nl: "a girl with short silver hair",  // 自然语言外貌（可空）
      source: "ai",        // 'manual' 用户手写 | 'ai' AI 在剧情里建的档 | 'book' 从柏宝书同步
      scope: "chat",       // 'chat' 本聊天档案 | 'global' 全局角色库（跨聊天）
      desc: "银色短发",     // 建档时那句「为什么长这样」（多为空串）
    },
  ],
}
```

`tag` 是按固定顺序（同人身份→性别→头发→眼睛→肤色→体型→标志特征→着装）拼好的，与柏宝绘自己出图用的串**完全一致**。不建议自己从 `fields` 拼——老条目可能只有整串原文，那条回落逻辑在 `tag` 里已经处理过了。

### 读历史某一楼的角色档案

角色档案会随剧情演进（AI 在某楼给角色换了发色）。要为**历史某一楼**出图，就得用那一楼当时的档案，否则会把后来的变更也画进去：

```js
// 第 42 楼**之前**的角色库快照（不含该楼）
const atFloor = globalThis.STBaiBaiImage.getCharacters({ floor: 42 });
```

## 出图前先问后端

```js
const status = globalThis.STBaiBaiImage.getBackendStatus();

if (!status.configured) {
  toastr.warning(status.reason);   // reason 是人话，可直接展示给用户
  return;
}
```

返回结构：

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  backend: "nai",              // 'nai' | 'comfyui'
  configured: true,
  model: "nai-diffusion-4-5-full",  // NAI 是模型名；ComfyUI 是当前工作流预设名
  supportsCharacters: true,    // 当前后端支不支持多角色提示
  reason: "",                  // configured=false 时的原因；已就绪为空串
}
```

> **不含服务地址与 API Key。** 这两样永远不会出现在任何公开返回值里。

`supportsCharacters` 只看模型，与配没配齐无关——你可以在用户还没填 Key 时就知道该不该准备 `characters`。**ComfyUI 恒为 `false`**。

用户当前选的若是 ComfyUI **漫画方案**，`configured` 也是 `false`（`reason` 会说明）：漫画模型吃的是分镜，不是你递进来的插画提示词。此时调 `generate` 同样报 `not_configured`。

## 调生图

```js
const api = globalThis.STBaiBaiImage;

const result = await api.generate({
  prompt: '1girl, silver hair, moonlight, night sky',
  nl: 'a girl standing under the moonlight',
  size: 'portrait',
});

myPanel.querySelector('img').src = result.dataUrl;   // 想显示在哪就显示在哪
```

### 请求参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | `string` | **必填**，正向 danbooru 短 tag。空串抛 `invalid_args` |
| `nl` | `string?` | 自然语言描述 |
| `negative` | `string?` | 本画面动态负面。**只对 ComfyUI 生效**；NAI 的负面取用户当前出图方案的配置 |
| `characters` | `PublicCharacterPrompt[]?` | 多角色提示，见下 |
| `size` | `'portrait' \| 'landscape'?` | 画幅方向，缺省 `'portrait'`。具体像素取用户在渠道页配的尺寸。**用户在渠道里锁定了画幅方向时一律按锁定方向出图**，这里传什么都不算数（0.3.1 起） |
| `seed` | `number?` | 指定种子（正整数）。省略 = 按用户设置决定 |
| `save` | `boolean?` | 落盘进柏宝绘图库，**默认 `true`** |
| `character` | `string?` | 落盘归到哪个角色名下（图库分组名）。省略 = 当前聊天的角色名 |

### 返回值

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  dataUrl: "data:image/png;base64,...",   // 可直接 <img src>
  format: "png",
  path: "/user/images/柏宝绘_阿黛尔/bbi_....png",  // 落盘路径；save=false 或落盘失败为 null
  seed: 3847562910,       // 本次实际使用的种子；想复现就把它填回 seed
  backend: "nai",
  charactersApplied: true,
}
```

图是 **data URL** 而不是 blob URL：blob 要配对 `revokeObjectURL`，你忘了就泄漏、我们替你 revoke 又会让你的 `<img>` 突然变空白。代价是字符串比较大，用完别长期留在内存里。

### 关于 `save`

- `true`（默认）：图存进 `user/images/柏宝绘_<character>/`，并写一份同名侧写 json 记下提示词和种子。于是用户能在**柏宝绘图库页**里按角色分组看到它、连提示词一起。侧写记的是**实际出图的方向**（用户锁定了画幅时与你传的 `size` 不同）。
- `false`：只返回 `dataUrl`，不碰磁盘。适合「预览一下就丢」。

落盘**失败不会抛错**——图已经在 `dataUrl` 里了，不能因为存不进图库就让你连图都拿不到。这种情况 `path` 是 `null`。

### 多角色（NAI 4.5 / V5）

```js
const status = api.getBackendStatus();
const library = api.getCharacters().characters;

const result = await api.generate({
  prompt: '2girls, cafe, afternoon light',
  characters: status.supportsCharacters
    ? library.slice(0, 2).map(c => ({ name: c.name, tag: c.tag, nl: c.nl }))
    : [],
});

if (!result.charactersApplied) {
  console.log('当前后端不支持多角色，这次只用了 prompt');
}
```

`charactersApplied` 明说这次到底用上了没有。柏宝绘**刻意不降级**把角色拼进 `prompt`——那会画出多份躯干重叠的图。要画多角色，请先看 `supportsCharacters`。

### 进度与取消

```js
const controller = new AbortController();

const result = await api.generate(
  { prompt: '1girl' },
  {
    signal: controller.signal,
    onProgress: p => {
      // 'queued' 在柏宝绘的 NAI 并发闸门里排队
      // 'generating' 请求已发出，后端正在画
      // 'queued-remote' 在 ComfyUI 服务端队列里（p.ahead 为前面还有几个）
      // 'retrying' 被限流了，正在退避重试（p.attempt / p.max）
      // 'saving' 图已拿到，正在落盘
      console.log(p.phase, p.ahead, p.attempt, p.max);
    },
  },
);

// 取消：generate 会抛 code='aborted'
controller.abort();
```

`onProgress` 抛错只会被记进 console，不影响生成。

### 错误处理

```js
try {
  await api.generate({ prompt: '1girl' });
} catch (error) {
  switch (error.code) {
    case 'aborted':        break;                        // 你自己取消的
    case 'not_configured': toastr.warning(error.message); break;  // 用户没配好后端
    case 'invalid_args':   console.error(error.message);  break;  // 你传错了
    case 'rate_limited':   toastr.warning('被限流了，稍后再试'); break;
    case 'backend_error':  toastr.error(error.message);   break;
  }
}
```

`rate_limited` 与 `backend_error` 分开，是因为处置方式不同：前者该等一会儿再来（柏宝绘的自动退避重试已经用尽了），后者是配置/网络问题，立刻重来也是同样的错。

### 不要绕过这个接口

柏宝绘内部的 NAI 请求全部走**并发闸门 + 节奏控制**（每个接入点一道；429 冷却、相邻请求最小间隔、指数退避重试）。这个接口把闸门包在里面了。如果你绕过它直接打 NAI 的 `generate-image`，用户的账号会吃一串密集 429——而用户只会认为是柏宝绘坏了。

## 订阅角色库变更

```js
const unsubscribe = globalThis.STBaiBaiImage.subscribe(notice => {
  console.log(notice.type);      // 'ready' | 'changed'
  console.log(notice.revision);  // 与 getCharacters().revision 同源
  console.log(notice.chatId);
  refreshMyCharacterPicker();
});

// 不需要时记得退订
unsubscribe();
```

切聊天、删楼、滑动、用户手动改档案、AI 在剧情里建档——凡是角色库变了都会通知。同一批变更会攒成一条，不会刷屏。

也可以直接监听 DOM 事件（内容与 `subscribe` 的回调参数相同）：

```js
window.addEventListener('st-baibai-image:ready', e => console.log(e.detail));
window.addEventListener('st-baibai-image:changed', e => console.log(e.detail));
```

## 完整示例

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) return callback(globalThis.STBaiBaiImage);
  window.addEventListener('st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage), { once: true });
}

useBaiBaiImage(async api => {
  if (api.apiVersion !== 1) {
    console.warn('柏宝绘接口版本不匹配', api.apiVersion);
    return;
  }

  const status = api.getBackendStatus();
  if (!status.configured) {
    toastr.warning(`柏宝绘未就绪：${status.reason}`);
    return;
  }

  const heroine = api.getCharacters().characters.find(c => c.name === '阿黛尔');
  if (!heroine) return;

  try {
    const result = await api.generate({
      prompt: `${heroine.tag}, cafe, afternoon light`,
      nl: heroine.nl,
      size: 'landscape',
      character: heroine.name,   // 落盘归到「柏宝绘_阿黛尔」目录下
    });
    document.querySelector('#my-portrait').src = result.dataUrl;
  } catch (error) {
    if (error.code !== 'aborted') toastr.error(error.message, '出图失败');
  }
});
```

## 接口一览

```ts
interface STBaiBaiImageApi {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  getCharacters(options?: { floor?: number }): PublicCharacterList;
  getBackendStatus(): PublicBackendStatus;
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>;
  subscribe(listener: (notice: PublicChangeNotice) => void): () => void;
}
```

完整类型定义见插件源码 `src/public/types.ts`。

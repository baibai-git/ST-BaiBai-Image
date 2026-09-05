/**
 * base64 编码的公共实现。
 *
 * 为什么必须走 TextEncoder 而不是 `btoa(text)`:btoa 的入参是 latin1 二进制串,
 * 码点 > 255 直接抛 InvalidCharacterError —— 提示词、角色名里全是中文,
 * 直接 btoa 会在存图时炸掉。先 UTF-8 编码成字节、再逐字节转 latin1 才是安全路径。
 *
 * 分块拼接是为了防栈溢出:String.fromCharCode(...bytes) 一次性展开几 MB 的数组
 * 会超出参数个数上限。
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

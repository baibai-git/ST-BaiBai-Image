import type { TargetSegment } from '@/autoTag/clean';
import { parseImagePlan, type ImagePlan } from '@/autoTag/protocol';

function field(text: string, name: string): string {
  return text.match(new RegExp(`<${name}\\s*>([\\s\\S]*?)</${name}>`, 'i'))?.[1].trim() || '';
}

function plain(text: string): string {
  return text.replace(/<Tag_think\b[\s\S]*?<\/Tag_think>/gi, '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function locate(anchor: string, segments: TargetSegment[]): string {
  const id = anchor.trim().replace(/^[\[⟦]|[\]⟧]$/g, '').toUpperCase();
  if (segments.some(s => s.id === id)) return id;
  // Treat legacy <regex> as a literal quotation. Never execute model-supplied regexes.
  const quote = anchor.replace(/\s+/g, ' ').trim();
  const matches = quote ? segments.filter(s => s.text.replace(/\s+/g, ' ').includes(quote)) : [];
  if (matches.length === 1) return matches[0].id;
  throw new Error('预设输出的 <regex> 无法唯一定位正文，请使用 P编号或该段唯一的原文片段');
}

/** 自定义预设优先遵守柏宝绘 JSON，兼容旧预设坚持返回的 XML。 */
export function parsePresetImagePlan(
  raw: string, segments: TargetSegment[], minImages: number, maxImages: number,
  characterPrompts: boolean,
): ImagePlan {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const blocks = [...cleaned.matchAll(/<images\s*>([\s\S]*?)<\/images>/gi)];
  let plan: ImagePlan;
  if (!blocks.length) {
    plan = parseImagePlan(raw, segments, minImages, maxImages);
  } else {
    const inner = blocks[blocks.length - 1][1];
    const images = [...inner.matchAll(/<image\s*>([\s\S]*?)<\/image>/gi)].map(match => {
      const body = match[1];
      const prompts = field(body, 'prompts');
      if (!prompts) throw new Error('预设 <image> 缺少 <prompts>');
      const scene = plain(field(prompts, 'scene_composition'));
      const characters = [...prompts.matchAll(/<character_(\d+)\s*>([\s\S]*?)<\/character_\1>/gi)]
        .map(c => {
          const tag = plain(field(c[2], 'prompt') || c[2]);
          return { name: plain(field(c[2], 'name')) || tag.match(/^([^,，.。]{1,40})[,，]/)?.[1] || `角色 ${c[1]}`, tag, nl: tag };
        }).filter(c => c.tag);
      const combined = characters.length ? [scene, ...characters.map(c => c.tag)].filter(Boolean).join(', ') : plain(prompts);
      return {
        position: locate(field(body, 'position') || field(body, 'regex'), segments),
        tag: characterPrompts && characters.length ? scene || 'scene' : combined,
        nl: characterPrompts && characters.length ? scene : combined,
        characters: characterPrompts ? characters : [],
        negative: plain(field(body, 'negative') || field(body, 'uc')),
        size: field(body, 'size'),
      };
    });
    if (inner.trim() && !images.length) throw new Error('预设 <images> 中没有可解析的 <image>');
    plan = parseImagePlan(JSON.stringify({ images }), segments, minImages, maxImages);
  }
  const contents = plan.images.flatMap(i => [i.tag, i.nl, i.negative, ...i.characters.flatMap(c => [c.tag, c.nl])]);
  if (contents.some(text => /\$\{[\s\S]*?\}\$/.test(text))) {
    throw new Error('预设返回了未展开的角色/服装调用 ${...}$，请让模型展开为实际描述或补充角色设定');
  }
  return plan;
}

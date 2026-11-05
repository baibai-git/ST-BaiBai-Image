import { describe, expect, it } from 'vitest';

import {
  buildSimpleWorkflow,
  normalizeSimpleConfig,
  simpleDefaults,
  templateSupportsNegative,
  validateSimpleConfig,
  type ComfySimpleConfig,
  type SimpleWorkflowNode,
} from '@/backends/comfyTemplates';

const VALUES = { prompt: '1girl, silver hair', seed: 42, width: 832, height: 1216 };

function config(patch: Partial<ComfySimpleConfig>): ComfySimpleConfig {
  return { ...simpleDefaults(), ...patch };
}

function node(workflow: Record<string, SimpleWorkflowNode>, id: string): SimpleWorkflowNode {
  const found = workflow[id];
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

describe('validateSimpleConfig', () => {
  it('未选模型时报错', () => {
    expect(validateSimpleConfig(simpleDefaults())).toContain('模型');
  });

  it('flux/anima 缺 VAE 或 CLIP 时报对应字段;checkpoint 外置 VAE 可留空', () => {
    const flux = { ...simpleDefaults('flux'), model: 'flux1-dev.safetensors' };
    expect(validateSimpleConfig(flux)).toContain('VAE');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors' })).toContain('T5-XXL');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors' })).toContain('CLIP-L');
    expect(
      validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors', clip2: 'clip_l.safetensors' }),
    ).toBeNull();

    const anima = { ...simpleDefaults('anima'), model: 'anima.safetensors', vae: 'qwen_image_vae.safetensors' };
    expect(validateSimpleConfig(anima)).toContain('Qwen');
    expect(validateSimpleConfig({ ...anima, clip1: 'qwen_2.5_vl_7b.safetensors' })).toBeNull();

    expect(validateSimpleConfig(config({ model: 'illustrious.safetensors' }))).toBeNull();
  });
});

describe('buildSimpleWorkflow - checkpoint', () => {
  const simple = config({ model: 'illustrious_xl.safetensors', positive: 'masterpiece, best quality', negative: 'worst quality' });

  it('组出经典五节点链路,正负面按「固定+生成」拼接', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '1').inputs.ckpt_name).toBe('illustrious_xl.safetensors');
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('worst quality, extra people');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, '6').inputs).toMatchObject({
      seed: 42,
      steps: 28,
      cfg: 5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
    });
    // 无外置 VAE → 用 checkpoint 内置(槽位 2)
    expect(node(wf, '7').inputs.vae).toEqual(['1', 2]);
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('nl 存在时优先于 tag 作为正向生成内容', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, nl: 'A girl with silver hair.' });
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, A girl with silver hair.');
  });

  it('固定词留空时只剩生成内容(不多逗号)', () => {
    const wf = buildSimpleWorkflow(config({ model: 'm.safetensors' }), VALUES);
    expect(node(wf, '3').inputs.text).toBe('1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('');
  });

  it('外置 VAE 走 VAELoader;LoRA 串联在底模与编码之间', () => {
    const wf = buildSimpleWorkflow(
      config({
        model: 'm.safetensors',
        vae: 'fix_vae.safetensors',
        loras: [
          { name: 'style.safetensors', strength: 0.8 },
          { name: '', strength: 1 }, // 未填完的行被忽略
          { name: 'detail.safetensors', strength: 0.5 },
        ],
      }),
      VALUES,
    );
    expect(node(wf, '2').class_type).toBe('VAELoader');
    expect(node(wf, '7').inputs.vae).toEqual(['2', 0]);
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'detail.safetensors', model: ['300', 0], clip: ['300', 1] });
    expect(node(wf, '6').inputs.model).toEqual(['301', 0]);
    expect(node(wf, '3').inputs.clip).toEqual(['301', 1]);
    expect(wf['302']).toBeUndefined();
  });
});

describe('buildSimpleWorkflow - flux', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('flux'),
    model: 'flux1-dev.safetensors',
    vae: 'ae.safetensors',
    clip1: 't5xxl_fp8.safetensors',
    clip2: 'clip_l.safetensors',
  };

  it('UNet + DualCLIP + ae,负面恒空、cfg 恒 1、走 FluxGuidance', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'ignored' });
    expect(node(wf, '1').class_type).toBe('UNETLoader');
    expect(node(wf, '2').inputs).toMatchObject({ clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' });
    expect(node(wf, '5').inputs.text).toBe('');
    expect(node(wf, '6').inputs).toMatchObject({ guidance: 3.5, conditioning: ['4', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ cfg: 1, positive: ['6', 0], negative: ['5', 0] });
    expect(node(wf, '7').class_type).toBe('EmptySD3LatentImage');
  });

  it('guidance = 1 时跳过 FluxGuidance,直连编码输出', () => {
    const wf = buildSimpleWorkflow({ ...simple, guidance: 1 }, VALUES);
    expect(wf['6']).toBeUndefined();
    expect(node(wf, '8').inputs.positive).toEqual(['4', 0]);
  });

  it('GGUF 用 UnetLoaderGGUF;LoRA 只挂 model(LoraLoaderModelOnly)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, gguf: true, loras: [{ name: 'flux_lora.safetensors', strength: 1 }] },
      VALUES,
    );
    expect(node(wf, '1').class_type).toBe('UnetLoaderGGUF');
    expect(node(wf, '300').class_type).toBe('LoraLoaderModelOnly');
    expect(node(wf, '300').inputs).not.toHaveProperty('clip');
    expect(node(wf, '8').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima'),
    model: 'anima_pencil.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_2.5_vl_7b.safetensors',
  };

  it('CLIPLoader 用 qwen_image 类型,模型过 ModelSamplingAuraFlow(shift 可调)', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'blurry' });
    expect(node(wf, '2').inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image' });
    expect(node(wf, '6').inputs).toMatchObject({ shift: 3, model: ['1', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ model: ['6', 0], cfg: 4 });
    expect(node(wf, '5').inputs.text).toBe('blurry');
  });

  it('LoRA 链尾接进 AuraFlow 而不是采样器', () => {
    const wf = buildSimpleWorkflow({ ...simple, loras: [{ name: 'a.safetensors', strength: 1 }] }, VALUES);
    expect(node(wf, '6').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - moss', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('moss'),
    model: 'moss_image_sft.safetensors',
    vae: 'flux2-vae.safetensors',
    clip1: 'qwen3.5_9b.safetensors',
  };

  it('MOSS 使用 moss_image 编码器和 Flux2 潜空间，正负面及 LoRA 接入同一采样链', () => {
    const wf = buildSimpleWorkflow({...simple,loras:[{name:'style.safetensors',strength:.7}]}, {...VALUES,negative:'blurry'});
    expect(node(wf,'2').inputs).toEqual({clip_name:'qwen3.5_9b.safetensors',type:'moss_image'});
    expect(node(wf,'3').inputs.vae_name).toBe('flux2-vae.safetensors');
    expect(node(wf,'7')).toEqual({class_type:'EmptyFlux2LatentImage',inputs:{width:VALUES.width,height:VALUES.height,batch_size:1}});
    expect(node(wf,'6').inputs).toEqual({shift:5,model:['300',0]});
    expect(node(wf,'4').inputs.clip).toEqual(['2',0]);
    expect(node(wf,'5').inputs).toEqual({text:'blurry',clip:['2',0]});
    expect(node(wf,'8').inputs).toMatchObject({steps:50,cfg:3,sampler_name:'euler',scheduler:'sgm_uniform',model:['6',0],positive:['4',0],negative:['5',0],latent_image:['7',0]});
  });

  it('MOSS 配置持久化后保留模板，仍按 VAE 与 Qwen3.5 逐项校验，不改变默认模板', () => {
    expect(simpleDefaults().template).toBe('checkpoint');
    expect(normalizeSimpleConfig(undefined).template).toBe('checkpoint');
    expect(normalizeSimpleConfig(JSON.parse(JSON.stringify(simple)))).toEqual(simple);
    expect(validateSimpleConfig({...simple,vae:''})).toContain('Flux2 VAE');
    expect(validateSimpleConfig({...simple,clip1:''})).toContain('Qwen3.5-9B');
    expect(validateSimpleConfig(simple)).toBeNull();
    expect(templateSupportsNegative('moss')).toBe(true);
  });
});

describe('buildSimpleWorkflow - 尺寸', () => {
  it('尺寸无效时报错(简易模式的画布节点是必建的,没有「工作流写死尺寸」的豁免)', () => {
    const simple = config({ model: 'm.safetensors' });
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, width: 0 })).toThrow('尺寸');
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, height: 0 })).toThrow('尺寸');
  });
});

describe('normalizeSimpleConfig', () => {
  it('空输入给 checkpoint 默认值', () => {
    expect(normalizeSimpleConfig(undefined)).toEqual(simpleDefaults());
  });

  it('非法 template 回 checkpoint;脏字段逐项归位', () => {
    const normalized = normalizeSimpleConfig({
      template: 'qwen-whatever',
      model: 42,
      steps: 'not a number',
      loras: [{ name: 'a.safetensors', strength: '0.7' }, null, 'junk'],
    });
    expect(normalized.template).toBe('checkpoint');
    expect(normalized.model).toBe('');
    expect(normalized.steps).toBe(28);
    expect(normalized.loras).toEqual([
      { name: 'a.safetensors', strength: 0.7 },
      { name: '', strength: 1 },
      { name: '', strength: 1 },
    ]);
  });

  it('合法 template 的采样参数按该模板默认值兜底', () => {
    expect(normalizeSimpleConfig({ template: 'flux' })).toEqual(simpleDefaults('flux'));
    expect(normalizeSimpleConfig({ template: 'anima' }).shift).toBe(3);
  });
});

describe('templateSupportsNegative', () => {
  it('flux 无真实负面输入,其余有', () => {
    expect(templateSupportsNegative('flux')).toBe(false);
    expect(templateSupportsNegative('checkpoint')).toBe(true);
    expect(templateSupportsNegative('anima')).toBe(true);
  });
});

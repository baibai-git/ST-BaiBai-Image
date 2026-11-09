import { expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, reactive, ssrContextKey } from 'vue';
vi.mock('@/state/ui', () => ({ modalHost: null }));
import Combo from './BbiCombo.vue';

it('路径只在失焦时缩短显示；编辑和选项始终保留完整存储值', () => {
  const props = reactive({ modelValue: 'moss\\style.safetensors', options: [], compactPath: true });
  const updates: string[] = [];
  let state: any;
  const renderer = createRenderer<any, any>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, patchProp() {}, insert() {}, remove() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp(defineComponent({ setup() {
    state = (Combo as any).setup(props, { expose() {}, emit(event: string, value: string) {
      if (event === 'update:modelValue') { updates.push(value); props.modelValue = value; }
    } });
    return () => null;
  } }));
  app.provide(ssrContextKey, {}); app.mount({});
  try {
    expect(state.displayValue.value).toBe('style.safetensors');
    state.onFocus();
    expect(state.displayValue.value).toBe('moss\\style.safetensors');
    state.onInput({ target: { value: 'another/style.safetensors' } });
    state.onBlur();
    expect(state.displayValue.value).toBe('style.safetensors');
    expect(props.modelValue).toBe('another/style.safetensors');
    state.pick('third/style.safetensors');
    expect(props.modelValue).toBe('third/style.safetensors');
    expect(updates).toEqual(['another/style.safetensors', 'third/style.safetensors']);
    props.compactPath = false;
    expect(state.displayValue.value).toBe(props.modelValue);
  } finally { app.unmount(); }
});

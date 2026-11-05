import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateComfyImage } from '@/backends/comfyui';
import type { ComfyRunConn } from '@/state/settings';

vi.mock('@/st/context', () => ({ getContext: () => ({ getRequestHeaders: () => ({}) }) }));
const conn = { url: 'http://127.0.0.1:8188', workflow: '{"1":{"class_type":"Test","inputs":{"text":"%prompt%"}}}', mode: 'custom', imageFormat: 'jpeg' } as ComfyRunConn;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const history = (pid: string) => json({ [pid]: { status: { completed: true }, outputs: { '1': { images: [{ filename: 'source.png', type: 'output' }] } } } });
const image = () => new Response(new Blob(['jpeg-test'], { type: 'image/jpeg' }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ComfyUI 已提交任务恢复与串行取图', () => {
  it('reserves reading order before a slow probe and POST acknowledgement, without waiting for generation', async () => {
    const order: string[] = [];
    let probes = 0;
    let releaseProbe!: () => void, releaseAck!: () => void, releaseHistory!: () => void;
    const probe = new Promise<void>(resolve => { releaseProbe = resolve; });
    const ack = new Promise<void>(resolve => { releaseAck = resolve; });
    const pendingHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith('/system_stats')) { if (++probes === 1) await probe; return json({}); }
      if (u.endsWith('/prompt')) {
        const text = JSON.parse(String(init?.body)).prompt['1'].inputs.text;
        order.push(text);
        if (text === 'first') await ack;
        return json({ prompt_id: text });
      }
      if (u.includes('/history/')) { await pendingHistory; return history(u.split('/').pop()!); }
      if (u.includes('/view?')) return image();
      throw new Error(u);
    }));
    const first = generateComfyImage(conn, { prompt: 'first' });
    const second = generateComfyImage(conn, { prompt: 'second' });
    try {
      await vi.waitFor(() => expect(probes).toBe(1));
      expect(order).toEqual([]);
      releaseProbe();
      await vi.waitFor(() => expect(order).toEqual(['first']));
      expect(probes).toBe(1);
      releaseAck();
      await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
      expect(probes).toBe(2); // Both submitted while the first generation is still unfinished.
    } finally {
      releaseProbe(); releaseAck(); releaseHistory();
      (await Promise.all([first, second])).forEach(result => result.revoke());
    }
  });

  it('cancelling a queued submission skips it without allowing later tasks to overtake the active probe', async () => {
    let probes = 0;
    const order: string[] = [];
    let release!: () => void;
    const probe = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith('/system_stats')) { if (++probes === 1) await probe; return json({}); }
      if (u.endsWith('/prompt')) { const text = JSON.parse(String(init?.body)).prompt['1'].inputs.text; order.push(text); return json({ prompt_id: text }); }
      if (u.includes('/history/')) return history(u.split('/').pop()!);
      if (u.includes('/view?')) return image();
      throw new Error(u);
    }));
    const abort = new AbortController();
    const first = generateComfyImage(conn, { prompt: 'first' });
    const cancelled = expect(generateComfyImage(conn, { prompt: 'cancelled' }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const third = generateComfyImage(conn, { prompt: 'third' });
    try {
      abort.abort(); await cancelled;
      expect(probes).toBe(1); expect(order).toEqual([]);
    } finally {
      release(); (await Promise.all([first, third])).forEach(result => result.revoke());
    }
    expect(order).toEqual(['first', 'third']);
  });

  it('a failed submission releases FIFO order and is not duplicated', async () => {
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith('/prompt')) {
        const text = JSON.parse(String(init?.body)).prompt['1'].inputs.text; order.push(text);
        if (text === 'first') throw new TypeError('lost acknowledgement');
        return json({ prompt_id: text });
      }
      if (u.includes('/history/')) return history(u.split('/').pop()!);
      if (u.includes('/view?')) return image();
      return json({});
    }));
    const first = expect(generateComfyImage(conn, { prompt: 'first' })).rejects.toThrow('lost acknowledgement');
    const second = generateComfyImage(conn, { prompt: 'second' });
    await first; (await second).revoke();
    expect(order).toEqual(['first', 'second']);
  });

  it('history transport/503 failures retry the same ID and never submit another prompt', async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input); paths.push(u);
      if (u.endsWith('/prompt')) return json({ prompt_id: 'original-id' });
      if (u.includes('/history/')) {
        if (++reads === 1) throw new TypeError('Network request failed');
        if (reads === 2) return json({ error: 'temporary' }, 503);
        return history('original-id');
      }
      if (u.includes('/view?')) return image();
      return json({});
    }));
    const result = generateComfyImage(conn, { prompt: 'test' });
    const checked = result.then(value => { expect(value.format).toBe('jpg'); value.revoke(); });
    await vi.runAllTimersAsync(); await checked;
    expect(paths.filter(p => p.endsWith('/prompt'))).toHaveLength(1);
    expect(paths.filter(p => p.includes('/history/'))).toEqual(Array(3).fill(conn.url + '/history/original-id'));
    expect(paths.some(p => p.includes('/api/sd/comfy/generate'))).toBe(false);
  });

  it('downloads JPG preview and retries a broken image body without changing source filename or submitting', async () => {
    vi.useFakeTimers();
    let reads = 0, submits = 0;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/prompt')) { submits++; return json({ prompt_id: 'same' }); }
      if (u.includes('/history/')) return history('same');
      if (u.includes('/view?')) {
        urls.push(u);
        if (++reads === 1) return { ok: true, blob: async () => { throw new TypeError('body interrupted'); } };
        return image();
      }
      return json({});
    }));
    const result = generateComfyImage(conn, { prompt: 'test' });
    const checked = result.then(value => { expect(value.filename).toBe('source.jpg'); expect(value.format).toBe('jpg'); value.revoke(); });
    await vi.runAllTimersAsync(); await checked;
    expect(submits).toBe(1); expect(urls).toHaveLength(2); expect(urls[0]).toBe(urls[1]);
    const url = new URL(urls[0]); expect(url.searchParams.get('filename')).toBe('source.png'); expect(url.searchParams.get('preview')).toBe('jpeg;92');
  });

  it('two tasks can be queued but only one image body downloads at a time', async () => {
    let pid = 0, downloads = 0;
    let releaseFirst!: () => void;
    const firstBody = new Promise<void>(resolve => { releaseFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/prompt')) return json({ prompt_id: `pid-${++pid}` });
      if (u.includes('/history/')) return history(u.split('/').pop()!);
      if (u.includes('/view?')) { downloads++; return { ok: true, blob: async () => { if (downloads === 1) await firstBody; return new Blob(['jpeg'], { type: 'image/jpeg' }); } }; }
      return json({});
    }));
    const first = generateComfyImage(conn, { prompt: 'first' });
    const second = generateComfyImage(conn, { prompt: 'second' });
    await vi.waitFor(() => expect(pid).toBe(2));
    expect(downloads).toBe(1);
    releaseFirst();
    const results = await Promise.all([first, second]); results.forEach(result => result.revoke());
    expect(downloads).toBe(2);
  });

  it('a failed POST is not sent again via the server', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input); paths.push(u);
      if (u.endsWith('/prompt')) throw new TypeError('acknowledgement lost');
      return json({});
    }));
    await expect(generateComfyImage(conn, { prompt: 'test' })).rejects.toThrow('acknowledgement lost');
    expect(paths.filter(p => p.endsWith('/prompt'))).toHaveLength(1);
    expect(paths.some(p => p.includes('/api/sd/'))).toBe(false);
  });

  it('retry exhaustion retains the task ID; auth failures and user cancellation do not retry', async () => {
    vi.useFakeTimers();
    let reads = 0, submits = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/prompt')) { submits++; return json({ prompt_id: 'keep-task' }); }
      if (u.includes('/history/')) { reads++; throw new TypeError('offline'); }
      return json({});
    }));
    const checked = expect(generateComfyImage(conn, { prompt: 'test' })).rejects.toThrow('keep-task');
    await vi.runAllTimersAsync(); await checked;
    expect(reads).toBe(4); expect(submits).toBe(1);
    reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/prompt')) return json({ prompt_id: 'denied' });
      if (u.includes('/history/')) { reads++; return json({ error: 'auth' }, 401); }
      return json({});
    }));
    await expect(generateComfyImage(conn, { prompt: 'test' })).rejects.toThrow('401');
    expect(reads).toBe(1);
  });

  it('server history errors recover by read-only requests to the same task', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input); paths.push(u);
      if (u.endsWith('/system_stats')) throw new TypeError('cors');
      if (u === '/api/sd/comfy/generate') return new Response(`error sending request for url (${conn.url}/history/server-task)`, { status: 500 });
      if (u.includes('/history/')) return history('server-task');
      if (u.includes('/view?')) return image();
      throw new Error('unexpected submission');
    }));
    const result = await generateComfyImage({ ...conn, imageFormat: 'original' }, { prompt: 'test' }); result.revoke();
    expect(paths.filter(p => p === '/api/sd/comfy/generate')).toHaveLength(1);
    expect(paths.filter(p => p.endsWith('/prompt'))).toHaveLength(0);
    expect(paths).toContain(conn.url + '/history/server-task');
  });

  it('JPG mode reports missing direct access without falling back to large native transfers', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('cors'); }); vi.stubGlobal('fetch', fetcher);
    await expect(generateComfyImage(conn, { prompt: 'test' })).rejects.toThrow('--enable-cors-header');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('native generation requests serialize because that API hides the download stage', async () => {
    let native = 0;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/system_stats')) throw new TypeError('cors');
      if (u === '/api/sd/comfy/generate') {
        if (++native === 1) await hold;
        return json({ format: 'png', data: 'cG5n' });
      }
      throw new Error('unexpected');
    }));
    const original = { ...conn, imageFormat: 'original' as const };
    const first = generateComfyImage(original, { prompt: 'one' });
    const second = generateComfyImage(original, { prompt: 'two' });
    await vi.waitFor(() => expect(native).toBe(1));
    release(); await Promise.all([first, second]);
    expect(native).toBe(2);
  });

  it('cancelling a queued download does not let a third task overtake the active transfer', async () => {
    let submitted = 0, downloads = 0;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/prompt')) return json({ prompt_id: `pid-${++submitted}` });
      if (u.includes('/history/')) return history(u.split('/').pop()!);
      if (u.includes('/view?')) { downloads++; return { ok: true, blob: async () => { if (downloads === 1) await hold; return new Blob(['jpeg'], { type: 'image/jpeg' }); } }; }
      if (u.endsWith('/queue')) return json({ queue_running: [], queue_pending: [] });
      return json({});
    }));
    const first = generateComfyImage(conn, { prompt: 'first' });
    const controller = new AbortController();
    const second = generateComfyImage(conn, { prompt: 'second' }, controller.signal);
    const cancelled = expect(second).rejects.toThrow();
    await vi.waitFor(() => expect(submitted).toBe(2));
    controller.abort(); await cancelled;
    const third = generateComfyImage(conn, { prompt: 'third' });
    await vi.waitFor(() => expect(submitted).toBe(3));
    expect(downloads).toBe(1);
    release(); const results = await Promise.all([first, third]); results.forEach(result => result.revoke());
    expect(downloads).toBe(2);
  });

  it('native error URLs cannot redirect recovery to an unrelated service', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const u = String(input); paths.push(u);
      if (u.endsWith('/system_stats')) throw new TypeError('cors');
      return new Response('error sending request for url (http://unrelated.invalid/history/leak)', { status: 500 });
    }));
    await expect(generateComfyImage({ ...conn, imageFormat: 'original' }, { prompt: 'test' })).rejects.toThrow('500');
    expect(paths).toEqual([conn.url + '/system_stats', '/api/sd/comfy/generate']);
  });
});

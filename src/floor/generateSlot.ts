import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { effectiveOrientation, type Orientation } from '@/backends/size';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { beginGen, clearGen, failGen, getGenRecord, isCurrentGen, setGenPhase, setGenRetry, setQueueAhead, slotKey } from '@/floor/genState';
import { imagePanel, panelSeq, readPanelSlots, type PanelSlot } from '@/floor/panelSlots';
import { latestEntry, promptHash, readStore, saveImageResult } from '@/floor/storage';
import { beginImage, failImage, finishImage, safeHistory } from '@/state/history';
import { activeComfyPreset, activeOrientationLock, settings } from '@/state/settings';
import { getContext } from '@/st/context';
import { parseImageTagContent } from '@/st/imageTagRegex';
import { isSameMessage } from '@/st/messageEdit';

interface SlotJob {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  tag: string;
  prompt: string;
  nl: string;
  negative: string;
  characters: ImageCharacterPrompt[];
  size: Orientation;
}

export async function generateSlot(job: SlotJob, onSaved?: () => void): Promise<void> {
  const ctx = getContext();
  if (!ctx || ctx.getCurrentChatId() !== job.chatId || !backendStatus().configured) return;
  const original = ctx.chat[job.messageId];
  const panelSlot = job.seq < 0;
  const key = slotKey(job.chatId, job.messageId, job.swipeId, job.seq);
  const phase = getGenRecord(key)?.phase;
  if (phase === 'queued' || phase === 'generating') return;
  const nai = settings.defaultBackend === 'nai';
  const { signal, token } = beginGen(key, promptHash(job.tag), nai ? 'queued' : 'generating');
  const ownsSlot = () => {
    const current = getContext();
    if (!isCurrentGen(key, token) || current?.getCurrentChatId() !== job.chatId) return false;
    if (!panelSlot) return true;
    const message = current.chat[job.messageId];
    if (!original || !message || !isSameMessage(message, original)) return false;
    const owner = (message.swipe_id ?? 0) === job.swipeId ? message : message.swipe_info?.[job.swipeId];
    return readPanelSlots(owner)[panelSeq(job.seq)]?.tag === job.tag;
  };
  let historyId: number | null = null;
  try {
    const seed = decideSeed(settings.defaultBackend);
    const size = effectiveOrientation(activeOrientationLock(), job.size);
    historyId = safeHistory(() => beginImage({
      backend: nai ? 'nai' : 'comfyui',
      model: nai ? settings.nai.model : activeComfyPreset().name,
      prompt: job.prompt, nl: job.nl, negative: job.negative, characters: job.characters,
      seed, size, floor: job.messageId, seq: panelSlot ? panelSeq(job.seq) : job.seq,
    }));
    const { result, meta } = await generateImage({ ...job, size, seed }, signal, {
      onStart: () => setGenPhase(key, token, 'generating'),
      onQueue: ahead => setQueueAhead(key, token, ahead),
      onRetry: retry => setGenRetry(key, token, retry),
    });
    try {
      if (!ownsSlot()) throw new DOMException('生图任务已失效', 'AbortError');
      await saveImageResult(job.messageId, job.swipeId, job.seq, job.tag, seed, result, meta, ownsSlot);
    } finally {
      result.revoke();
    }
    if (historyId !== null) safeHistory(() => finishImage(historyId!));
    clearGen(key, token);
    if (panelSlot) imagePanel.revision++;
    else onSaved?.();
  } catch (error) {
    const aborted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const message = error instanceof Error ? error.message : String(error);
    if (historyId !== null) safeHistory(() => failImage(historyId!, message, aborted));
    if (aborted) clearGen(key, token);
    else failGen(key, token, message);
  }
}

export function generatePanelSlot(chatId: string, messageId: number, swipeId: number,
                                  index: number, slot: PanelSlot, force = false): void {
  const ctx = getContext();
  if (!ctx || ctx.getCurrentChatId() !== chatId) return;
  const message = ctx.chat[messageId];
  if (!message || (message.swipe_id ?? 0) !== swipeId) return;
  const seq = panelSeq(index);
  if (!force && latestEntry(readStore(message), swipeId, promptHash(slot.tag), seq)) return;
  const { tag: prompt, ...fields } = parseImageTagContent(slot.tag);
  void generateSlot({ ...fields, chatId, messageId, swipeId, seq, tag: slot.tag, prompt });
}

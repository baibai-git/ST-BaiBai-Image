import type { TargetSegment } from '@/autoTag/clean';
import type { ImageInsertion } from '@/autoTag/protocol';
import { rebaseImagePositions } from '@/autoTag/rebase';
import { generatePanelSlot } from '@/floor/generateSlot';
import { cancelGen, reconcileGen, slotKey } from '@/floor/genState';
import { imagePanel, makePanelSlots, panelSeq, panelSlotUpdate, readPanelSlots, type PanelSlot } from '@/floor/panelSlots';
import { promptHash } from '@/floor/storage';
import { applyMessageText, type MessageExtraUpdate } from '@/st/messageEdit';
import { serializeImageTag, stripImageTags } from '@/st/imageTagRegex';
import type { STMessage } from '@/st/context';

interface PanelPlan {
  floor: number;
  chatId: string;
  swipeId: number | null;
  message: STMessage;
  previous: PanelSlot[];
  images: ImageInsertion[];
  segments: TargetSegment[];
  customStripTags: string[];
  rewrite: number | undefined;
  extras: MessageExtraUpdate[];
  autoGenerate: boolean;
}

export async function storePanelPlan(plan: PanelPlan): ReturnType<typeof applyMessageText> {
  const { floor, chatId, swipeId, message, previous, images, segments, customStripTags, rewrite, extras, autoGenerate } = plan;
  let slots: PanelSlot[] = [];
  const result = await applyMessageText(floor, (_liveText, liveMessage) => {
    const current = readPanelSlots(liveMessage);
    if (current.length !== previous.length || current.some((slot, i) => slot.tag !== previous[i].tag)) return null;
    if (rewrite === undefined) {
      const source = stripImageTags(liveMessage.mes);
      const rebuilt = rebaseImagePositions(source, segments, images, customStripTags);
      if (!rebuilt) return null;
      slots = makePanelSlots(rebuilt.images, source);
    } else {
      slots = current.map((slot, i) => i === rewrite ? { ...slot, tag: serializeImageTag(images[0]) } : slot);
    }
    return { extra: [panelSlotUpdate(slots), ...extras] };
  }, chatId, swipeId, message);
  if (result !== 'saved') return result;

  const activeSwipe = swipeId ?? 0;
  previous.forEach((_, index) => {
    const key = slotKey(chatId, floor, activeSwipe, panelSeq(index));
    if (slots[index]) reconcileGen(key, promptHash(slots[index].tag));
    else cancelGen(key);
  });
  imagePanel.revision++;
  if (rewrite !== undefined) generatePanelSlot(chatId, floor, activeSwipe, rewrite, slots[rewrite], true);
  else if (autoGenerate) slots.forEach((slot, i) => generatePanelSlot(chatId, floor, activeSwipe, i, slot));
  return result;
}

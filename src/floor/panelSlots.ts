import { reactive } from 'vue';
import type { ImageInsertion } from '@/autoTag/protocol';
import type { STMessage } from '@/st/context';
import type { MessageExtraUpdate } from '@/st/messageEdit';
import { serializeImageTag } from '@/st/imageTagRegex';

const PANEL_SLOTS_KEY = 'bbiPanelSlots';

export interface PanelSlot {
  tag: string;
  sourceLine: number;
  excerpt: string;
}

export const imagePanel = reactive({ open: false, floor: null as number | null, revision: 0 });

export function openImagePanel(floor: number | null = null): void {
  imagePanel.floor = floor;
  imagePanel.revision++;
  imagePanel.open = true;
}

// Panel slots use the negative half of the shared history/queue keys, including on a mixed floor.
export function panelSeq(index: number): number {
  return -1 - index;
}

export function readPanelSlots(message: Pick<STMessage, 'extra'> | undefined): PanelSlot[] {
  const slots = message?.extra?.[PANEL_SLOTS_KEY];
  if (!Array.isArray(slots)) return [];
  return slots.filter((slot): slot is PanelSlot =>
    !!slot && typeof slot.tag === 'string' && Number.isSafeInteger(slot.sourceLine) && typeof slot.excerpt === 'string');
}

export function panelSlotUpdate(slots: PanelSlot[]): MessageExtraUpdate {
  return { key: PANEL_SLOTS_KEY, value: slots.length ? slots : undefined };
}

export function makePanelSlots(images: ImageInsertion[], text: string): PanelSlot[] {
  const lines = text.split(/\r\n|\r|\n/);
  return images.map(image => ({
    tag: serializeImageTag(image),
    sourceLine: image.sourceLine,
    excerpt: (lines[image.sourceLine] ?? '').trim().slice(0, 220),
  }));
}

import { describe, expect, it } from 'vitest';
import { isCollapsedSlot } from './slotAnchors';

function node(tagName: string, parentElement: any = null, open = false): HTMLElement {
  const element: any = { tagName, parentElement, children: [], hasAttribute: (name: string) => name === 'open' && open,
    contains(child: any): boolean { for (let current = child; current; current = current.parentElement) if (current === element) return true; return false; } };
  parentElement?.children.push(element);
  return element;
}

describe('collapsed picture anchors', () => {
  it('detects an image card hidden in a closed summary body', () => {
    const mes = node('DIV'), details = node('DETAILS', mes);
    node('SUMMARY', details);
    expect(isCollapsedSlot(node('DIV', details), mes)).toBe(true);
  });

  it('retains visible inline anchors and open details bodies', () => {
    const mes = node('DIV'), details = node('DETAILS', mes, true);
    expect(isCollapsedSlot(node('DIV', mes), mes)).toBe(false);
    expect(isCollapsedSlot(node('DIV', details), mes)).toBe(false);
  });

  it('does not misidentify the visible summary heading as a hidden body', () => {
    const mes = node('DIV'), details = node('DETAILS', mes), heading = node('SUMMARY', details);
    expect(isCollapsedSlot(node('DIV', heading), mes)).toBe(false);
  });

  it('detects an outer closed fold even when an inner fold is open', () => {
    const mes = node('DIV'), outer = node('DETAILS', mes), inner = node('DETAILS', outer, true);
    expect(isCollapsedSlot(node('DIV', inner), mes)).toBe(true);
  });
});

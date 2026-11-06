import { describe, expect, it } from 'vitest';
import { boxToPercent, isValidBox, layoutOverlays } from './overlay';

// 04-acme-changed-bank.png is 892 x 1263 px.
const ASPECT = 1263 / 892;

describe('isValidBox / boxToPercent', () => {
  it('accepts only finite 0..1 boxes with positive size', () => {
    expect(isValidBox([0.1, 0.2, 0.3, 0.4])).toBe(true);
    expect(isValidBox([0.3, 0.2, 0.1, 0.4])).toBe(false);
    expect(isValidBox([0.1, 0.2, 0.3, 0.2])).toBe(false);
    expect(isValidBox([0.1, 0.2, 1.3, 0.4])).toBe(false);
    expect(isValidBox([0.1, 0.2, NaN, 0.4])).toBe(false);
    expect(isValidBox([0.1, 0.2, 0.3])).toBe(false);
    expect(isValidBox(null)).toBe(false);
  });

  it('converts to CSS percentages', () => {
    expect(boxToPercent([0.067, 0.391, 0.935, 0.471])).toEqual({ left: 6.7, top: 39.1, width: 86.8, height: 8 });
  });
});

describe('layoutOverlays', () => {
  const boxes = {
    vendor: [0.06, 0.03, 0.66, 0.11] as [number, number, number, number],
    invoice_number: [0.81, 0.16, 0.94, 0.18] as [number, number, number, number],
    total: [0.79, 0.34, 0.92, 0.36] as [number, number, number, number],
    payment_instructions: [0.07, 0.39, 0.93, 0.47] as [number, number, number, number],
  };
  const items = [
    { n: 1, ok: true, anchor: 'vendor' as const },
    { n: 2, ok: true, anchor: 'total' as const },
    { n: 3, ok: false, anchor: 'payment_instructions' as const },
  ];

  it('outlines only regions with a tone; pins at the vertical centre of their region', () => {
    const o = layoutOverlays(boxes, items, { invoice_number: 'ok', total: 'ok', payment_instructions: 'bad' }, ASPECT);
    expect(o.outlines.map((x) => [x.field, x.tone])).toEqual([['invoice_number', 'ok'], ['total', 'ok'], ['payment_instructions', 'bad']]);
    expect(o.outlines[2]).toMatchObject({ left: 7, top: 39, width: 86, height: 8 });
    expect(o.pins).toEqual([
      { n: 1, ok: true, side: 'left', top: 7 },
      { n: 2, ok: true, side: 'left', top: 35 },
      { n: 3, ok: false, side: 'left', top: 43 },
    ]);
  });

  it('moves a clashing pin to the right edge, then down the left edge', () => {
    const near = { a: [0.1, 0.5, 0.2, 0.52], b: [0.3, 0.5, 0.4, 0.52] } as const;
    const o = layoutOverlays(
      { total: [...near.a], invoice_number: [...near.b], vendor: [...near.a] },
      [{ n: 1, ok: true, anchor: 'total' }, { n: 2, ok: false, anchor: 'invoice_number' }, { n: 3, ok: false, anchor: 'vendor' }],
      {},
      ASPECT,
      { displayWidth: 560 },
    );
    expect(o.pins.map((p) => p.side)).toEqual(['left', 'right', 'left']);
    const sep = (o.pins[2].top - o.pins[0].top) / 100;
    expect(sep * 560 * ASPECT).toBeGreaterThanOrEqual(26 - 0.01); // pin 22px + gap 4px (percent rounding)
  });

  it('skips findings whose region has no (valid) box and keeps pins inside the image', () => {
    const o = layoutOverlays(
      { total: [0.1, 0.995, 0.2, 1], vendor: [0.5, 0.2, 0.4, 0.3] as [number, number, number, number] },
      [{ n: 1, ok: true, anchor: 'vendor' }, { n: 2, ok: false, anchor: 'total' }, { n: 3, ok: false, anchor: null }],
      { vendor: 'ok', total: 'bad' },
      ASPECT,
    );
    expect(o.outlines.map((x) => x.field)).toEqual(['total']);
    expect(o.pins).toHaveLength(1);
    expect(o.pins[0].n).toBe(2);
    expect(o.pins[0].top).toBeLessThan(100);
  });

  it('pins a region once, for its first finding', () => {
    const o = layoutOverlays(boxes, [{ n: 1, ok: false, anchor: 'vendor' }, { n: 2, ok: true, anchor: 'total' }, { n: 3, ok: false, anchor: 'vendor' }], {}, ASPECT);
    expect(o.pins.map((p) => p.n)).toEqual([1, 2]);
  });

  it('no boxes or a bad aspect -> no overlays (the image is shown plain)', () => {
    expect(layoutOverlays(null, items, { total: 'ok' }, ASPECT)).toEqual({ outlines: [], pins: [] });
    expect(layoutOverlays(boxes, items, { total: 'ok' }, 0)).toEqual({ outlines: [], pins: [] });
    expect(layoutOverlays(boxes, items, { total: 'ok' }, Number.NaN)).toEqual({ outlines: [], pins: [] });
  });
});

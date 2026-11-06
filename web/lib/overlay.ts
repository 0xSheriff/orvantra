// Box -> overlay math for the annotated invoice. Pure.
// Boxes are normalized [x0, y0, x1, y1] in 0..1 of the page image (top-left origin). Overlays are positioned in
// percentages of the displayed image, so they stay aligned at any rendered size.
import type { Box, BoxField, Boxes } from 'orvantra-agent/boxes';

export interface OverlayOutline {
  field: BoxField;
  tone: 'ok' | 'bad';
  /** Percentages of the image box. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OverlayPin {
  n: number;
  ok: boolean;
  side: 'left' | 'right';
  /** Vertical centre, percentage of the image height. */
  top: number;
}

export interface Overlays {
  outlines: OverlayOutline[];
  pins: OverlayPin[];
}

export interface LayoutOptions {
  /** Width the image is displayed at, px (used only to keep pins apart). */
  displayWidth?: number;
  pinPx?: number;
  gapPx?: number;
}

const FIELDS: BoxField[] = ['vendor', 'invoice_number', 'total', 'payment_instructions'];

/** A usable normalized box: four finite numbers, inside 0..1, positive width and height. */
export function isValidBox(b: unknown): b is Box {
  if (!Array.isArray(b) || b.length !== 4) return false;
  if (!b.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return false;
  return b[2] > b[0] && b[3] > b[1];
}

const pct = (v: number) => Math.round(v * 100000) / 1000; // 3 decimals of a percent

export function boxToPercent(b: Box): { left: number; top: number; width: number; height: number } {
  return { left: pct(b[0]), top: pct(b[1]), width: pct(b[2] - b[0]), height: pct(b[3] - b[1]) };
}

/**
 * Outlines for every region that has a tone and a valid box; one pin per finding whose anchor region has a valid
 * box. Pins sit on the page edge at the region's vertical centre: left edge first, the right edge if that spot is
 * taken, otherwise pushed down the left edge until they no longer overlap.
 * `aspect` = image height / width.
 */
export function layoutOverlays(
  boxes: Boxes | null | undefined,
  items: { n: number; ok: boolean; anchor: BoxField | null }[],
  tones: Partial<Record<BoxField, 'ok' | 'bad'>>,
  aspect: number,
  opts: LayoutOptions = {},
): Overlays {
  if (!boxes || !(aspect > 0) || !Number.isFinite(aspect)) return { outlines: [], pins: [] };
  const valid: Partial<Record<BoxField, Box>> = {};
  for (const f of FIELDS) if (isValidBox(boxes[f])) valid[f] = boxes[f] as Box;

  const outlines: OverlayOutline[] = [];
  for (const f of FIELDS) {
    const b = valid[f];
    const tone = tones[f];
    if (b && tone) outlines.push({ field: f, tone, ...boxToPercent(b) });
  }

  const displayWidth = opts.displayWidth ?? 560;
  const pinPx = opts.pinPx ?? 22;
  const gapPx = opts.gapPx ?? 4;
  const heightPx = displayWidth * aspect;
  const minSep = (pinPx + gapPx) / heightPx; // normalized
  const half = pinPx / 2 / heightPx;

  const placed: { side: 'left' | 'right'; y: number }[] = [];
  const clash = (side: 'left' | 'right', y: number) => placed.some((p) => p.side === side && Math.abs(p.y - y) < minSep - 1e-9);
  const pins: OverlayPin[] = [];
  const pinned = new Set<BoxField>();
  for (const it of items) {
    const b = it.anchor ? valid[it.anchor] : undefined;
    // One pin per region: a second finding on the same region is listed on the right only.
    if (!b || pinned.has(it.anchor!)) continue;
    pinned.add(it.anchor!);
    let y = Math.min(1 - half, Math.max(half, (b[1] + b[3]) / 2));
    let side: 'left' | 'right' = 'left';
    if (clash('left', y)) {
      if (!clash('right', y)) side = 'right';
      else {
        while (clash('left', y) && y < 1 - half) y = Math.min(1 - half, y + minSep / 2);
      }
    }
    placed.push({ side, y });
    pins.push({ n: it.n, ok: it.ok, side, top: pct(y) });
  }
  return { outlines, pins };
}

// Optional bounding boxes for key invoice regions, asked of reader A (Qwen3-VL, a grounding-capable vision model).
// Boxes are only used to draw overlays in the web UI. They never influence a decision.
// Stored form: normalized [x0, y0, x1, y1] in 0..1 of the FIRST page image, top-left origin.

export const BOX_FIELDS = ['invoice_number', 'total', 'vendor', 'payment_instructions'] as const;
export type BoxField = (typeof BOX_FIELDS)[number];
export type Box = [number, number, number, number];
export type Boxes = Partial<Record<BoxField, Box>>;

const nullableBox = { type: ['array', 'null'], items: { type: 'number' } };

/** JSON-schema fragment for the `boxes` property (nullable; every field nullable). */
export const BOXES_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [...BOX_FIELDS],
  properties: {
    invoice_number: { ...nullableBox, description: 'Box around the printed invoice number' },
    total: { ...nullableBox, description: 'Box around the printed total amount due' },
    vendor: { ...nullableBox, description: 'Box around the vendor name/address/account block' },
    payment_instructions: { ...nullableBox, description: 'Box around the printed payment instructions text, or null if none' },
  },
} as const;

export const BOXES_PROMPT = `- boxes: for invoice_number, total, vendor (the block with the vendor's name, address and account) and payment_instructions
  (the printed payment / bank / wallet text), give the bounding box on the FIRST page as [x0, y0, x1, y1] integers in 0..1000,
  relative to the image width and height, origin top-left. Use null for anything not printed.`;

/**
 * Validate one box. Accepts 0..1 or 0..1000 coordinates (Qwen-VL's native grounding scale); a box with any
 * coordinate > 1 is read as 0..1000. Small overshoot is clamped. Returns null for anything malformed or degenerate.
 */
export function normalizeBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map((x) => (typeof x === 'string' ? Number(x) : x));
  if (!n.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const nums = n as number[];
  const scale = nums.some((x) => x > 1) ? 1000 : 1;
  if (nums.some((x) => x < -0.02 * scale || x > 1.02 * scale)) return null;
  const [x0, y0, x1, y1] = nums.map((x) => Math.min(1, Math.max(0, x / scale)));
  if (!(x1 > x0 && y1 > y0)) return null;
  if (x1 - x0 < 0.005 || y1 - y0 < 0.003) return null;
  return [x0, y0, x1, y1];
}

/** Parse the model's `boxes` object; keeps only valid boxes. Returns null when nothing usable is left. */
export function parseBoxes(v: unknown): Boxes | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Boxes = {};
  for (const f of BOX_FIELDS) {
    const b = normalizeBox((v as Record<string, unknown>)[f]);
    if (b) out[f] = b;
  }
  return Object.keys(out).length ? out : null;
}

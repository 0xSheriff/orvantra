import { describe, expect, it } from 'vitest';
import { BOX_FIELDS, BOXES_SCHEMA, normalizeBox, parseBoxes } from '../src/boxes.ts';
import { buildRequest, EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_WITH_BOXES, parseExtraction } from '../src/extract.ts';
import { imageSize, newRecordId, RECORD_ID } from '../src/records.ts';

describe('normalizeBox', () => {
  it('keeps 0..1 boxes as they are', () => {
    expect(normalizeBox([0.1, 0.2, 0.5, 0.3])).toEqual([0.1, 0.2, 0.5, 0.3]);
  });
  it('reads boxes with a coordinate > 1 as 0..1000 (Qwen-VL grounding scale)', () => {
    expect(normalizeBox([100, 200, 500, 300])).toEqual([0.1, 0.2, 0.5, 0.3]);
  });
  it('clamps a small overshoot and accepts numeric strings', () => {
    expect(normalizeBox(['0', '10', '1005', '40'])).toEqual([0, 0.01, 1, 0.04]);
  });
  it('rejects malformed, inverted, out-of-range and degenerate boxes', () => {
    expect(normalizeBox(null)).toBe(null);
    expect(normalizeBox([1, 2, 3])).toBe(null);
    expect(normalizeBox([0.5, 0.2, 0.1, 0.3])).toBe(null); // x1 < x0
    expect(normalizeBox([0.1, 0.3, 0.5, 0.3])).toBe(null); // zero height
    expect(normalizeBox([10, 10, 2000, 50])).toBe(null); // beyond 1000
    expect(normalizeBox([0.1, 0.1, 0.101, 0.5])).toBe(null); // too thin
    expect(normalizeBox([0.1, 'x', 0.2, 0.3])).toBe(null);
  });
});

describe('parseBoxes', () => {
  it('keeps only valid fields and drops unknown ones', () => {
    expect(parseBoxes({ total: [600, 330, 930, 360], vendor: null, invoice_number: [1, 2], extra: [0, 0, 1, 1] })).toEqual({ total: [0.6, 0.33, 0.93, 0.36] });
  });
  it('returns null when nothing is usable', () => {
    expect(parseBoxes(null)).toBe(null);
    expect(parseBoxes({ total: null })).toBe(null);
    expect(parseBoxes([1, 2, 3, 4])).toBe(null);
  });
});

describe('reader A schema with boxes', () => {
  it('requires every field (strict mode) and only adds `boxes`', () => {
    expect([...EXTRACTION_SCHEMA_WITH_BOXES.required].sort()).toEqual(Object.keys(EXTRACTION_SCHEMA_WITH_BOXES.properties).sort());
    expect(Object.keys(EXTRACTION_SCHEMA_WITH_BOXES.properties).filter((k) => !(k in EXTRACTION_SCHEMA.properties))).toEqual(['boxes']);
    expect([...BOXES_SCHEMA.required]).toEqual([...BOX_FIELDS]);
  });
  it('is only used when boxes are requested; the prompt asks for 0..1000 boxes', () => {
    const page = [{ mime: 'image/png' as const, data: Buffer.from('x') }];
    expect(buildRequest('m', page).response_format.json_schema.schema).toBe(EXTRACTION_SCHEMA);
    const r = buildRequest('m', page, { boxes: true });
    expect(r.response_format.json_schema.schema).toBe(EXTRACTION_SCHEMA_WITH_BOXES);
    expect(r.messages[0].content).toContain('0..1000');
  });
  it('parseExtraction keeps valid boxes and never fails on bad ones', () => {
    const base = { vendor_name: 'A', invoice_number: '1', total: '1' };
    expect(parseExtraction(JSON.stringify({ ...base, boxes: { total: [0, 0, 500, 100] } })).boxes).toEqual({ total: [0, 0, 0.5, 0.1] });
    expect(parseExtraction(JSON.stringify({ ...base, boxes: 'nonsense' })).boxes).toBe(null);
    expect('boxes' in parseExtraction(JSON.stringify(base))).toBe(false);
  });
});

describe('records helpers', () => {
  it('imageSize reads PNG and JPEG headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(892, 16);
    png.writeUInt32BE(1263, 20);
    expect(imageSize(png)).toEqual({ width: 892, height: 1263 });
    // SOI, APP0 (len 4), SOF0 (len 17): precision, height 300, width 200
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpg)).toEqual({ width: 200, height: 300 });
    expect(imageSize(Buffer.from('GIF89a'))).toBe(null);
  });
  it('record ids are fixed-shape (safe as file names)', () => {
    const id = newRecordId(1793990000000, () => 0xabc);
    expect(id).toBe('1793990000000-00000abc');
    expect(RECORD_ID.test(id)).toBe(true);
    expect(RECORD_ID.test('../ledger')).toBe(false);
  });
});

// Offline tests for the request/response plumbing (no model calls).
import { describe, expect, it } from 'vitest';
import { buildRequest, EXTRACTION_SCHEMA, parseExtraction, readerSpecs, sniffType } from '../src/extract.ts';

describe('parseExtraction', () => {
  const json = { vendor_name: 'Acme', vendor_near_account: 'acme.near', invoice_number: 'INV-1', issue_date: '2026-11-02', due_date: '2026-12-02', currency: 'USDC', total: '120.00', line_items: [{ description: 'x', amount: '120.00' }], payment_instructions_text: null };

  it('parses plain JSON', () => {
    expect(parseExtraction(JSON.stringify(json))).toEqual(json);
  });

  it('tolerates <think> blocks and code fences', () => {
    expect(parseExtraction(`<think>reading { the total }</think>\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``)).toEqual(json);
  });

  it('coerces missing/odd values instead of trusting the shape', () => {
    const e = parseExtraction('{"vendor_name":"A","total":120,"vendor_near_account":"","line_items":null}');
    expect(e.total).toBe('120');
    expect(e.vendor_near_account).toBe(null);
    expect(e.line_items).toEqual([]);
    expect(e.invoice_number).toBe('');
  });

  it('throws on non-JSON output', () => {
    expect(() => parseExtraction('I cannot read this invoice')).toThrow();
  });
});

describe('buildRequest', () => {
  it('sends the image as a data URL with a strict JSON schema and max_tokens 3000', () => {
    const r = buildRequest('m', [{ mime: 'image/png', data: Buffer.from('abc') }]);
    expect(r.max_tokens).toBe(3000);
    expect(r.response_format.json_schema.strict).toBe(true);
    const parts = r.messages[1].content;
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('abc').toString('base64')}` } });
  });

  it('schema requires every field and allows no extras', () => {
    expect([...EXTRACTION_SCHEMA.required].sort()).toEqual(Object.keys(EXTRACTION_SCHEMA.properties).sort());
    expect(EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('sniffType / readerSpecs', () => {
  it('detects file types by magic bytes', () => {
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffType(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(sniffType(Buffer.from('GIF89a'))).toBe(null);
  });

  it('defaults to two different NEAR AI model families', () => {
    const [a, b] = readerSpecs({});
    expect(a.model).toBe('Qwen/Qwen3-VL-30B-A3B-Instruct');
    expect(b.model).toBe('z-ai/glm-5.3-flash');
    expect(readerSpecs({ READER_B_MODEL: 'x/y' })[1].model).toBe('x/y');
  });
});

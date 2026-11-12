// The judges' test invoices: the FRESH judge set in agent/fixtures-judges/ (10 clean invoices from
// NovaTech Labs, GreenLeaf Co and PixelWorks Studio — never processed on any treasury, and separate
// from the 14 live invoices on the All invoices page) + EXPECTED.md, zipped on the fly. Read-only.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { serverConfig } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

const FIXTURE = /^\d+[\w.-]*\.(png|pdf)$/i;

export async function GET(): Promise<Response> {
  const dir = serverConfig().judgesFixturesDir;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => FIXTURE.test(n) || n === 'EXPECTED.md').sort();
  } catch {
    return new Response('The test invoices are not available on this server.', { status: 404 });
  }
  const zip = new JSZip();
  const folder = zip.folder('orvantra-test-invoices')!;
  for (const n of names) folder.file(n, await readFile(join(dir, n)));
  const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Response(body as Uint8Array<ArrayBuffer>, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="orvantra-test-invoices.zip"',
      // The zip content is refreshed per round — never serve a stale copy.
      'cache-control': 'no-store',
    },
  });
}

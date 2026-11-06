// Serves a stored invoice page image (agent/data/files/<id>.page1.png|jpg) or a CLI fixture image.
// Only fixed-shape names are accepted; nothing outside those two directories can be read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverConfig } from '@/lib/server/config';
import { fixtureExists } from '@/lib/server/data';

export const runtime = 'nodejs';

const PAGE = /^[0-9]{13}-[0-9a-f]{8}\.page1\.(png|jpg)$/;
const FIXTURE = /^fixture-([\w.-]+\.(png|jpe?g))$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const cfg = serverConfig();
  let path: string | null = null;
  if (PAGE.test(name)) path = join(cfg.filesDir, name);
  else {
    const m = name.match(FIXTURE);
    if (m && fixtureExists(cfg, m[1])) path = join(cfg.fixturesDir, m[1]);
  }
  if (!path) return new Response('not found', { status: 404 });
  try {
    const body = readFileSync(/*turbopackIgnore: true*/ path); // runtime data dir, not part of the build
    const type = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
    return new Response(new Uint8Array(body), { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

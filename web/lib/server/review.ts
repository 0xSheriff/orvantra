// Everything the review screen needs for one row, as plain serializable data.
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize } from 'orvantra-agent/records';
import { chainLabel, fmtAmount, routeLabel, shortAddr } from '../format';
import { crossChainEvidence } from '../evidence';
import { layoutOverlays, type Overlays } from '../overlay';
import { verdictFor, type Row } from '../rows';
import type { Verdict } from '../verdict';
import type { AppData } from './data';
import { fixtureExists, fixturePath } from './data';
import { keptOriginal } from './originals';

export interface ReviewImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  pages: number;
}

export interface ReviewView {
  key: string;
  title: string;
  verdict: Verdict;
  image: ReviewImage | null;
  overlays: Overlays;
  /** Why there are no overlays (shown under the image), if any. */
  overlayNote: string | null;
  pay: {
    paymentId: number | null;
    status: string | null;
    amount: string;
    vendorAccount: string | null;
    address: string | null;
    addressShort: string | null;
    route: string | null;
    eta: string | null;
    simulated: boolean;
    explorerUrl: string | null;
  };
  owner: string | null;
  treasuryId: string;
  vendorName: string;
  /** Set on a Rejected/Failed payment whose invoice hash is still held: the owner may free it (release_invoice_hash). */
  release: { paymentId: number } | null;
}

const PAGE_W = 540;

function imageFor(row: Row, d: AppData): ReviewImage | null {
  const r = row.record;
  const alt = `Invoice ${row.invoiceNumber ?? ''} from ${row.vendorName}`.replace(/\s+/g, ' ').trim();
  if (r?.page_image) {
    let size = r.page_size;
    if (!size) {
      try {
        size = imageSize(readFileSync(join(d.cfg.filesDir, r.page_image)));
      } catch {
        size = null;
      }
    }
    return {
      src: `/api/files/${r.page_image}`,
      width: size?.width ?? 892,
      height: size?.height ?? 1263,
      alt: `${alt}, page 1${r.pages > 1 ? ` of ${r.pages}` : ''}, as uploaded`,
      pages: r.pages,
    };
  }
  if (row.payment && row.invoiceHash) {
    const file = keptOriginal(row.invoiceHash);
    if (file) {
      const path = fixturePath(d.cfg, file);
      if (path) {
        let size: { width: number; height: number } | null = null;
        try {
          size = imageSize(readFileSync(path));
        } catch {
          size = null;
        }
        return { src: `/api/files/fixture-${file}`, width: size?.width ?? 892, height: size?.height ?? 1263, alt: `${alt}, as read by the agent`, pages: 1 };
      }
    }
  }
  if (row.fixtureFile && fixtureExists(d.cfg, row.fixtureFile)) {
    let size: { width: number; height: number } | null = null;
    try {
      size = imageSize(readFileSync(join(d.cfg.fixturesDir, row.fixtureFile)));
    } catch {
      size = null;
    }
    return { src: `/api/files/fixture-${row.fixtureFile}`, width: size?.width ?? 892, height: size?.height ?? 1263, alt: `${alt}, as read by the agent`, pages: 1 };
  }
  return null;
}

export function reviewView(row: Row, d: AppData, opts: { hashHeld?: boolean | null } = {}): ReviewView {
  const base = verdictFor(row, d.ctx);
  const image = imageFor(row, d);
  const boxes = row.record?.boxes ?? null;
  const overlays = image ? layoutOverlays(boxes, base.items, base.outlines, image.height / image.width, { displayWidth: PAGE_W }) : { outlines: [], pins: [] };
  const overlayNote = !image ? null
    : !row.record ? 'Read from the command line, so the agent did not mark regions on this invoice.'
      : !boxes ? 'The reader did not return the positions of these fields, so the findings are listed on the right only.'
        : null;

  const p = row.payment;
  const payout = p?.payout ?? (row.vendorAccount ? d.ctx.registry.get(row.vendorAccount)?.payout : null) ?? row.record?.registry_entry?.payout ?? null;
  const direct = p ? p.direct : payout ? payout.chain === 'near' && payout.asset_id === `nep141:${d.ctx.tokenId}` : false;
  const simulated = !direct && d.cfg.network !== 'mainnet' && !!payout;
  const secs = row.record?.quote?.time_estimate_s;
  // Cross-chain payouts wait for the owner to confirm the 1Click deposit address: show the evidence for it.
  const quote = row.record?.quote ?? null;
  const evidence = !direct && payout && (p || quote)
    ? crossChainEvidence({
      quote, chainQuoteHash: p?.quote_hash ?? null, depositAddress: p?.destination ?? p?.deposit_address ?? row.record?.deposit_address ?? null,
      registryAddress: payout.address, vendorAccount: row.vendorAccount,
    })
    : [];
  const verdict = evidence.length
    ? { ...base, items: [...base.items, ...evidence.map((e, i) => ({ ...e, n: base.items.length + i + 1, kind: 'cross-chain' as const, anchor: null }))] }
    : base;
  const eta = direct ? 'arrives in seconds' : secs ? `about ${secs} seconds` : payout && !simulated ? 'via 1Click' : null;
  return {
    key: row.key,
    title: row.invoiceNumber ?? (p ? `Payment #${p.id}` : 'Invoice'),
    verdict,
    image,
    overlays,
    overlayNote,
    pay: {
      paymentId: p?.id ?? null,
      status: p?.status ?? null,
      amount: row.amount ? `${fmtAmount(row.amount)} ${d.ctx.unit}` : '—',
      vendorAccount: row.vendorAccount,
      address: payout?.address ?? null,
      addressShort: payout ? shortAddr(payout.address) : null,
      route: routeLabel(payout, d.ctx.tokenId, d.ctx.unit) ?? (payout ? chainLabel(payout.chain) : null),
      eta,
      simulated,
      explorerUrl: row.record?.explorer_url
        ?? (row.ledger?.tx_hash ? `https://${d.cfg.network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${row.ledger.tx_hash}` : null),
    },
    owner: d.config?.owner ?? null,
    treasuryId: d.cfg.treasuryId,
    vendorName: row.vendorName,
    release: p && (p.status === 'Rejected' || p.status === 'Failed') && opts.hashHeld ? { paymentId: p.id } : null,
  };
}

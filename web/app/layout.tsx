import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';
import './globals.css';

const serif = Newsreader({ subsets: ['latin'], axes: ['opsz'], variable: '--font-serif', display: 'swap' });
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Orvantra', template: '%s · Orvantra' },
  description: 'Accounts payable that only pays the address a vendor registered on-chain, within the limits you set.',
};

export const dynamic = 'force-dynamic';

/** Fonts and the global stylesheet only. The owner app shell lives in (app)/layout; public pages in (public). */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

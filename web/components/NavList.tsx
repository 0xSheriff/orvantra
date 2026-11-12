'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavList({ counts }: { counts: { approval: number; invoices: number; vendors: number } }) {
  const path = usePathname();
  const items: { href: string; label: string; count?: number; on: boolean }[] = [
    { href: '/invoices', label: 'All invoices', count: counts.invoices, on: path.startsWith('/invoices') },
    { href: '/review', label: 'Needs approval', count: counts.approval, on: path === '/review' },
    { href: '/vendors', label: 'Vendors', count: counts.vendors, on: path.startsWith('/vendors') },
    { href: '/rules', label: 'Rules & limits', on: path.startsWith('/rules') },
    { href: '/activity', label: 'Activity', on: path.startsWith('/activity') },
  ];
  return (
    <nav className="navlist" aria-label="Main">
      {items.map((it) => (
        <Link key={it.href} href={it.href} className={it.on ? 'on' : undefined} aria-current={it.on ? 'page' : undefined}>
          {it.label}
          {it.count != null ? <span>{it.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

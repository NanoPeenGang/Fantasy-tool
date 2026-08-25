'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '', label: 'Dashboard' },
  { href: '/odds', label: 'Odds board' },
  { href: '/lineup', label: 'Start / sit' },
  { href: '/report', label: "Commissioner's Report" },
  { href: '/war-room', label: 'War room' },
];

export function LeagueNav({ leagueId }: { leagueId: string }) {
  const pathname = usePathname();
  const base = `/leagues/${leagueId}`;

  return (
    <nav className="nav">
      {TABS.map((tab) => {
        const href = `${base}${tab.href}`;
        const current = tab.href === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link key={tab.href} href={href} aria-current={current ? 'page' : undefined}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

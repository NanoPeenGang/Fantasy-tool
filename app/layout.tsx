import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'LeagueOps',
  description:
    'Fantasy football operations: draft prep, live matchup odds, post-game forensics, and a weekly league recap.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <Link href="/" className="wordmark">
              League<span>Ops</span>
            </Link>
            <div className="masthead-meta">Sleeper league operations</div>
          </header>
          {children}
          <footer className="site">
            LeagueOps lines are computed win probabilities, not sportsbook lines. No money
            moves through this platform.
          </footer>
        </div>
      </body>
    </html>
  );
}

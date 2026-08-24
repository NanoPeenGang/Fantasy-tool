import Link from 'next/link';
import { isDatabaseConfigured } from '@/lib/db/client';
import { listLeagues } from '@/lib/db/queries';
import { ConnectForm } from './connect-form';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const configured = isDatabaseConfigured();
  const leagues = configured ? await listLeagues().catch(() => []) : [];

  return (
    <main>
      <h1>Connect a league</h1>
      <p className="lede">
        Paste a Sleeper league ID. LeagueOps pulls the season, computes one stat packet per
        week, and renders it as a dashboard, a set of odds, an after-action report, and a
        recap you can paste into the league chat.
      </p>

      {!configured && (
        <div className="notice" style={{ marginTop: 22 }}>
          <strong>No database configured.</strong> Set <code>DATABASE_URL</code> and run{' '}
          <code>npm run db:migrate</code> before connecting a league. See the README.
        </div>
      )}

      <div className="card" style={{ marginTop: 22, maxWidth: 460 }}>
        <ConnectForm disabled={!configured} />
      </div>

      {leagues.length > 0 && (
        <>
          <h2>Connected leagues</h2>
          <div className="grid grid-2">
            {leagues.map((league) => (
              <Link
                key={league.id}
                href={`/leagues/${league.id}`}
                className="card"
                style={{ textDecoration: 'none' }}
              >
                <h3>{league.name}</h3>
                <div className="faint" style={{ fontSize: 13 }}>
                  {league.season} season · {league.roster_positions.length} roster slots
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2>What it computes</h2>
      <div className="grid grid-2">
        <div className="card">
          <h3>Odds board</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            Monte Carlo win probabilities with correlated player outcomes, updating on a
            60-second tick during games. Every tick is persisted, which is what produces the
            swing chart.
          </p>
        </div>
        <div className="card">
          <h3>Commissioner&apos;s Report</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            A weekly recap generated from the stat packet in three passes, with every number
            verified against the packet before delivery.
          </p>
        </div>
        <div className="card">
          <h3>After action report</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            Per matchup: why you lost, priced against your bench, your opponent&apos;s ceiling
            game, and the swap that would have flipped it.
          </p>
        </div>
        <div className="card">
          <h3>Power rankings</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            All-play records and a luck index, so a 5-2 team that has been outscored all
            season has nowhere to hide.
          </p>
        </div>
      </div>
    </main>
  );
}

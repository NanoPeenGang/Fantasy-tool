import Link from 'next/link';
import { databaseStatus } from '@/lib/db/client';
import { listLeagues } from '@/lib/db/queries';
import { ConnectForm } from './connect-form';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Probe before listing. The previous version swallowed the query error, so a
  // connected-but-unmigrated database looked identical to one with no leagues
  // in it — which is exactly the state a freshly attached Neon database is in.
  const status = await databaseStatus();
  const ready = status.configured && status.reachable && status.migrated;
  const leagues = ready ? await listLeagues().catch(() => []) : [];

  return (
    <main>
      <h1>Connect a league</h1>
      <p className="lede">
        Paste a Sleeper league ID. LeagueOps pulls the season, computes one stat packet per
        week, and renders it as a dashboard, a set of odds, an after-action report, and a
        recap you can paste into the league chat.
      </p>

      {!ready && <SetupNotice status={status} />}

      <div className="card" style={{ marginTop: 22, maxWidth: 460 }}>
        <ConnectForm disabled={!ready} />
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

/**
 * The setup banner. Each state names the one action that unblocks it — "no
 * database" and "database connected but empty" need completely different things
 * done, and collapsing them into one message is how someone ends up re-checking
 * a connection string that was correct all along.
 */
function SetupNotice({ status }: { status: Awaited<ReturnType<typeof databaseStatus>> }) {
  if (!status.configured) {
    return (
      <div className="notice" style={{ marginTop: 22 }}>
        <strong>No database attached.</strong> Add a Postgres database (Neon or Vercel
        Postgres) to the project, then redeploy so the app picks up the environment
        variable. Locally, set <code>DATABASE_URL</code> in <code>.env.local</code>.
      </div>
    );
  }

  if (!status.reachable) {
    return (
      <div className="notice" style={{ marginTop: 22 }}>
        <strong>Database attached but unreachable.</strong> Reading{' '}
        <code>{status.source}</code>. {status.error}
      </div>
    );
  }

  return (
    <div className="notice" style={{ marginTop: 22 }}>
      <strong>Database connected, but the schema has not been created yet.</strong>{' '}
      Reading <code>{status.source}</code>; {status.missingTables.length} table
      {status.missingTables.length === 1 ? ' is' : 's are'} missing. Attaching a database
      and creating its schema are two separate steps.
      <div style={{ marginTop: 10 }}>
        Run the migration once:
        <pre
          className="mono"
          style={{
            margin: '6px 0 0',
            padding: '10px 12px',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflowX: 'auto',
            fontSize: 12,
          }}
        >
          curl -X POST https://your-app.vercel.app/api/admin/migrate \\{'\n'}
          {'  '}-H &quot;Authorization: Bearer $CRON_SECRET&quot;
        </pre>
        <span className="faint" style={{ fontSize: 12 }}>
          Or <code>npm run db:migrate</code> locally. It is idempotent — safe to re-run.
          Check <a href="/api/health">/api/health</a> for the current state.
        </span>
      </div>
    </div>
  );
}

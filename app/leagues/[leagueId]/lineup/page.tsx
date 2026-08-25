import { notFound } from 'next/navigation';
import { getLeague, listManagers, listRosters, weekProjections } from '@/lib/db/queries';
import { databaseStatus } from '@/lib/db/client';
import { SchemaNotice } from '@/app/schema-notice';
import { currentState, fetchWeek } from '@/lib/jobs/ingest';
import { fallbackProjection } from '@/lib/jobs/odds';
import { playerDictionary } from '@/lib/sleeper/players';
import { adviseLineup, type LineupPlayer } from '@/lib/lineup/advisor';
import { LeagueNav } from '../nav';

export const dynamic = 'force-dynamic';

/**
 * Start/sit for the week ahead.
 *
 * Same solver that grades a finished week, run forward. Every call is priced in
 * win probability rather than points, because points are only meaningful
 * relative to what the opponent is likely to score.
 */
export default async function LineupPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string; roster?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam, roster: rosterParam } = await searchParams;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const status = await databaseStatus();
  if (!status.migrated) {
    return (
      <main>
        <h1>Start / sit</h1>
        <p className="lede">{league.name}</p>
        <LeagueNav leagueId={leagueId} />
        <SchemaNotice missingTables={status.missingTables} leagueScoped />
      </main>
    );
  }

  let week: number;
  let error: string | null = null;
  try {
    week = weekParam ? Number(weekParam) : (await currentState()).week;
  } catch {
    week = weekParam ? Number(weekParam) : 1;
    error = 'Could not reach Sleeper for the current week.';
  }

  const [rosters, managers] = await Promise.all([listRosters(leagueId), listManagers(leagueId)]);
  const selectedRosterId = rosterParam ? Number(rosterParam) : rosters[0]?.roster_id ?? null;

  let advice: Awaited<ReturnType<typeof buildAdvice>> = null;
  let hasProjections = false;

  if (!error && selectedRosterId !== null) {
    try {
      const projections = await weekProjections(league.season, week);
      hasProjections = Object.keys(projections).length > 0;
      advice = await buildAdvice(league, week, selectedRosterId, projections);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not build lineup advice.';
    }
  }

  const managerName =
    managers.find((m) => m.id === rosters.find((r) => r.roster_id === selectedRosterId)?.manager_id)
      ?.display_name ?? `Roster ${selectedRosterId}`;

  return (
    <main>
      <h1>Start / sit</h1>
      <p className="lede">
        {league.name} · week {week} · {managerName}
      </p>
      <LeagueNav leagueId={leagueId} />

      {rosters.length > 1 && (
        <div className="nav" style={{ marginBottom: 14 }}>
          {rosters.map((roster) => {
            const name =
              managers.find((m) => m.id === roster.manager_id)?.display_name ??
              `Roster ${roster.roster_id}`;
            return (
              <a
                key={roster.roster_id}
                href={`?roster=${roster.roster_id}&week=${week}`}
                aria-current={roster.roster_id === selectedRosterId ? 'page' : undefined}
              >
                {name}
              </a>
            );
          })}
        </div>
      )}

      {!hasProjections && !error && (
        <div className="notice">
          <strong>No projections loaded for week {week}.</strong> The advice below runs on
          positional replacement-level estimates, which treat every starter at a position as
          interchangeable — enough to catch an empty slot or a player on bye, not enough to
          settle a real start/sit. POST weekly numbers to{' '}
          <code className="mono">/api/leagues/{leagueId}/projections</code> to sharpen it.
        </div>
      )}

      {error && (
        <div className="notice">
          <strong>Could not build lineup advice.</strong> {error}
        </div>
      )}

      {advice && (
        <>
          {advice.flags.length > 0 && (
            <>
              <h2>Fix these first</h2>
              <div className="card">
                {advice.flags.map((flag, i) => (
                  <p key={i} style={{ margin: i === 0 ? 0 : '8px 0 0' }}>
                    <span className={`pill ${flag.kind === 'empty_slot' ? 'bad' : 'warn'}`}>
                      {flag.kind === 'empty_slot' ? 'empty' : flag.kind}
                    </span>{' '}
                    {flag.detail}
                  </p>
                ))}
              </div>
            </>
          )}

          <h2>This week</h2>
          <div className="grid grid-4">
            <div className="card stat">
              <span className="stat-label">Projected</span>
              <span className="stat-value">{advice.currentProjected}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">Optimal</span>
              <span className="stat-value">{advice.optimalProjected}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">On the bench</span>
              <span className={`stat-value ${advice.pointsLeftOnBench > 0 ? 'down' : ''}`}>
                {advice.pointsLeftOnBench}
              </span>
            </div>
            <div className="card stat">
              <span className="stat-label">Win probability</span>
              <span className="stat-value">
                {advice.currentWinProbability === null
                  ? '—'
                  : `${Math.round(advice.currentWinProbability * 100)}%`}
              </span>
              <span className="stat-note">
                {advice.optimalWinProbability !== null && advice.currentWinProbability !== null
                  ? `${Math.round(advice.optimalWinProbability * 100)}% if optimal`
                  : 'no opponent found'}
              </span>
            </div>
          </div>

          <h2>Recommended changes</h2>
          {advice.calls.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0 }}>
                Your lineup is already optimal against these projections. Nothing to change.
              </p>
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Start</th>
                    <th>Sit</th>
                    <th className="num">Points</th>
                    <th className="num">Win prob</th>
                  </tr>
                </thead>
                <tbody>
                  {advice.calls.map((call) => (
                    <tr key={call.startPlayer.id}>
                      <td className="faint">{call.slot}</td>
                      <td className="name up">
                        {call.startPlayer.name}
                        <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                          {call.startPlayer.position} · {call.startPlayer.projection} proj
                        </span>
                      </td>
                      <td className="name dim">
                        {call.sitPlayer?.name ?? 'an empty slot'}
                        {call.sitPlayer && (
                          <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                            {call.sitPlayer.position} · {call.sitPlayer.projection} proj
                          </span>
                        )}
                      </td>
                      <td className="num">+{call.pointsAdded}</td>
                      <td className="num up">
                        {call.winProbabilityAdded === null
                          ? '—'
                          : `+${Math.round(call.winProbabilityAdded * 1000) / 10}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            Ranked by win probability added, not points. A two-point upgrade is worth far more in
            a coin-flip matchup than in one already decided.
          </p>

          <h2>Optimal lineup</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Player</th>
                  <th className="num">Projected</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {advice.optimalLineup.map((slot, i) => (
                  <tr key={`${slot.slot}-${i}`}>
                    <td className="faint">{slot.slot}</td>
                    <td className="name">{slot.player?.name ?? <span className="down">empty</span>}</td>
                    <td className="num">{slot.projection}</td>
                    <td>
                      {slot.player?.started ? (
                        <span className="pill good">yes</span>
                      ) : (
                        <span className="pill bad">bench</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

async function buildAdvice(
  league: NonNullable<Awaited<ReturnType<typeof getLeague>>>,
  week: number,
  rosterId: number,
  projections: Record<string, number>,
) {
  const [snapshot, dictionary] = await Promise.all([
    fetchWeek(league, week),
    playerDictionary(),
  ]);

  const matchup = snapshot.matchups.find(
    (m) => m.a.rosterId === rosterId || m.b?.rosterId === rosterId,
  );
  if (!matchup) return null;

  const mine = matchup.a.rosterId === rosterId ? matchup.a : matchup.b;
  const theirs = matchup.a.rosterId === rosterId ? matchup.b : matchup.a;
  if (!mine) return null;

  const toLineup = (playerIds: string[], starters: string[]): LineupPlayer[] =>
    playerIds
      .filter((id) => id !== '0')
      .map((id) => {
        const player = dictionary[id];
        return {
          id,
          name: player?.name ?? id,
          position: player?.position ?? 'UNK',
          team: player?.team ?? null,
          injuryStatus: player?.injury_status ?? null,
          byeWeek: player?.bye_week ?? null,
          projection: projections[id] ?? fallbackProjection(player?.position ?? 'WR'),
          started: starters.includes(id),
        };
      });

  return adviseLineup({
    week,
    roster: toLineup(mine.players, mine.starters),
    rosterPositions: league.roster_positions,
    opponent: theirs ? toLineup(theirs.players, theirs.starters) : undefined,
  });
}

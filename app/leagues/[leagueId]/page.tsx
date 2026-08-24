import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLeague, getStatPacket, latestPacketWeek } from '@/lib/db/queries';
import type { StatPacket } from '@/lib/compute/types';
import { LeagueNav } from './nav';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const latest = await latestPacketWeek(leagueId);
  const week = weekParam ? Number(weekParam) : latest;
  const packet = week ? await getStatPacket(leagueId, week) : null;

  return (
    <main>
      <h1>{league.name}</h1>
      <p className="lede">
        {league.season} season{week ? ` · week ${week}` : ''}
      </p>
      <LeagueNav leagueId={leagueId} />

      {!packet ? (
        <div className="empty">
          <p>No stat packet computed yet.</p>
          <p className="faint" style={{ fontSize: 13 }}>
            The packet is built when the last game of a week goes final. Trigger it manually
            with <code className="mono">POST /api/cron/packet?leagueId={leagueId}</code>.
          </p>
        </div>
      ) : (
        <PacketView packet={packet} leagueId={leagueId} />
      )}
    </main>
  );
}

function PacketView({ packet, leagueId }: { packet: StatPacket; leagueId: string }) {
  return (
    <>
      <h2>Power rankings</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Manager</th>
              <th className="num">Record</th>
              <th className="num">All-play</th>
              <th className="num">Luck</th>
              <th className="num">PF</th>
              <th className="num">Week</th>
              <th className="num">Coach %</th>
            </tr>
          </thead>
          <tbody>
            {packet.teams.map((team) => (
              <tr key={team.managerId}>
                <td className="num">
                  {team.powerRank}
                  {team.rankDelta !== 0 && (
                    <span className={team.rankDelta > 0 ? 'up' : 'down'} style={{ marginLeft: 5 }}>
                      {team.rankDelta > 0 ? '▲' : '▼'}
                      {Math.abs(team.rankDelta)}
                    </span>
                  )}
                </td>
                <td className="name">
                  <div>{team.manager}</div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {team.teamName}
                  </div>
                </td>
                <td className="num">
                  {team.record.w}-{team.record.l}
                  {team.record.t > 0 ? `-${team.record.t}` : ''}
                </td>
                <td className="num dim">
                  {team.allPlay.w}-{team.allPlay.l}
                </td>
                <td className={`num ${team.luckIndex > 0.5 ? 'up' : team.luckIndex < -0.5 ? 'down' : 'dim'}`}>
                  {team.luckIndex > 0 ? '+' : ''}
                  {team.luckIndex}
                </td>
                <td className="num dim">{team.pf}</td>
                <td className="num">{team.score}</td>
                <td className="num dim">{Math.round(team.coachingEfficiency * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
        Luck is wins above all-play expectation. A positive number means the schedule has been
        kind.
      </p>

      <h2>This week</h2>
      <div className="grid grid-2">
        {packet.matchups.map((matchup) => {
          const winnerA = matchup.scoreA > matchup.scoreB;
          const managerName = winnerA ? matchup.b : matchup.a;
          return (
            <div key={matchup.matchupId} className="card">
              <div className="odds-side">
                <span className={winnerA ? 'odds-name' : 'odds-name dim'}>{matchup.a}</span>
                <span className={`odds-line ${winnerA ? '' : 'dim'}`}>{matchup.scoreA}</span>
              </div>
              <div className="odds-side" style={{ marginTop: 4 }}>
                <span className={!winnerA ? 'odds-name' : 'odds-name dim'}>
                  {matchup.b || <span className="faint">bye</span>}
                </span>
                <span className={`odds-line ${!winnerA ? '' : 'dim'}`}>{matchup.scoreB}</span>
              </div>

              <div className="odds-meta" style={{ marginTop: 10 }}>
                {matchup.closingUpset && <span className="pill warn">upset</span>}
                {matchup.coachingLoss && <span className="pill bad">coaching loss</span>}
                {matchup.deadOnArrival && <span className="pill">never in doubt</span>}
                {matchup.comebackIndex !== null && matchup.comebackIndex < 0.1 && (
                  <span className="pill good">heist</span>
                )}
              </div>

              {matchup.turningPoint && (
                <p className="dim" style={{ fontSize: 13, margin: '10px 0 0' }}>
                  {matchup.turningPoint.description}
                </p>
              )}
              <p className="faint" style={{ fontSize: 12, margin: '6px 0 0' }}>
                {matchup.marginVsBench}
              </p>

              {matchup.b && (
                <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                  <Link
                    className="pill"
                    href={`/leagues/${leagueId}/aar/${matchup.matchupId}?manager=${encodeURIComponent(matchup.a)}&week=${packet.week}`}
                  >
                    {matchup.a} AAR
                  </Link>
                  <Link
                    className="pill"
                    href={`/leagues/${leagueId}/aar/${matchup.matchupId}?manager=${encodeURIComponent(matchup.b)}&week=${packet.week}`}
                  >
                    {matchup.b} AAR
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {packet.awards.length > 0 && (
        <>
          <h2>Awards</h2>
          <div className="grid grid-3">
            {packet.awards.map((award) => (
              <div key={award.key} className="card stat">
                <span className="stat-label">{award.label}</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {award.manager}
                </span>
                <span className="stat-note">
                  {award.key === 'heist' || award.key === 'bagholder'
                    ? `${Math.round(award.value * 100)}%`
                    : award.value}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {packet.teamOfTheWeek && (
        <>
          <h2>Team of the week</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Player</th>
                  <th>Owner</th>
                  <th className="num">Points</th>
                  <th className="num">Started</th>
                </tr>
              </thead>
              <tbody>
                {packet.teamOfTheWeek.slots.map((slot) => (
                  <tr key={slot.playerId}>
                    <td className="faint">{slot.slot}</td>
                    <td className="name">{slot.player}</td>
                    <td className="dim">{slot.manager}</td>
                    <td className="num">{slot.points}</td>
                    <td className="num">
                      {slot.started ? <span className="up">yes</span> : <span className="down">no</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            {packet.teamOfTheWeek.total} points available, {packet.teamOfTheWeek.startedTotal}{' '}
            actually started.
          </p>
        </>
      )}

      {packet.hotPlayers.length > 0 && (
        <>
          <h2>Hottest players</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Rostered by</th>
                  <th className="num">Points</th>
                  <th className="num">Started</th>
                </tr>
              </thead>
              <tbody>
                {packet.hotPlayers.map((player) => (
                  <tr key={player.playerId}>
                    <td className="name">{player.player}</td>
                    <td className="faint">{player.position}</td>
                    <td className="dim">{player.rosteredBy ?? 'free agent'}</td>
                    <td className="num">{player.points}</td>
                    <td className="num">
                      {player.started ? (
                        <span className="dim">yes</span>
                      ) : (
                        <span className="down">benched</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

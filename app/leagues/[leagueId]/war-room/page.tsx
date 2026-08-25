import { notFound } from 'next/navigation';
import { getLeague } from '@/lib/db/queries';
import { scoringProfile } from '@/lib/compute/scoring';
import { assembleWarRoom } from '@/lib/warroom/assemble';
import { LeagueNav } from '../nav';
import { WatchButton } from './watch-button';
import { ImportDraftsButton } from './actions';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  projections: 'projections, scored for this league',
  league_adp: "this league's own draft history",
  none: 'no value source yet',
};

export default async function WarRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ pos?: string; hide?: string }>;
}) {
  const { leagueId } = await params;
  const { pos, hide } = await searchParams;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const room = await assembleWarRoom(league);
  const profile = scoringProfile(league.scoring_settings, league.roster_positions);

  const hideTaken = hide !== 'off';
  const visible = room.board.players
    .filter((player) => (pos ? player.position === pos : true))
    .filter((player) => (hideTaken ? !player.taken : true))
    .slice(0, 150);

  const watchlist = room.board.players.filter((player) => player.onWatchlist);
  const positions = [...new Set(room.board.players.map((p) => p.position))].sort();

  return (
    <main>
      <h1>War room</h1>
      <p className="lede">
        {league.name} · {profile.label} · board ranked on {SOURCE_LABEL[room.board.source]}
      </p>
      <LeagueNav leagueId={leagueId} />

      {room.draft.live && (
        <div className="notice info">
          <strong>Draft is live.</strong> {room.draft.pickCount} picks in.
          {room.draft.run?.runDetected && room.draft.runPosition && (
            <>
              {' '}
              <strong className="warn">
                {room.draft.runPosition} run: {room.draft.run.recentCount} of the last 5 picks.
              </strong>{' '}
              {Math.round(room.draft.run.survivalProbability * 100)}% chance the top tier survives
              to your next pick.
            </>
          )}
        </div>
      )}

      {!room.playersAvailable && (
        <div className="notice">
          <strong>The player dictionary is unavailable.</strong> Names, teams and bye weeks come
          from Sleeper&apos;s player list, refreshed once a day by{' '}
          <code className="mono">/api/cron/daily</code>. Until that has run, the board falls back
          to whoever this room has drafted before and shows player ids in place of names.
        </div>
      )}

      {room.board.source === 'none' && (
        <div className="notice">
          <strong>The board has no value source yet.</strong> Two ways to give it one, and they
          stack:
          <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            <li>
              <strong>Import this room&apos;s draft history</strong> — free, no vendor, and
              arguably the better number, since value is relative to the room you draft in.
            </li>
            <li>
              <strong>POST projections</strong> to{' '}
              <code className="mono">/api/leagues/{leagueId}/projections</code> with{' '}
              <code className="mono">week: 0</code> for season-long totals.
            </li>
          </ol>
          <div style={{ marginTop: 12 }}>
            <ImportDraftsButton leagueId={leagueId} />
          </div>
        </div>
      )}

      {room.warnings.length > 0 && (
        <>
          <h2>Know your room</h2>
          <div className="card">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {room.warnings.map((warning, i) => (
                <li key={i} style={{ margin: '4px 0' }}>
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <h2>Roster needs</h2>
      <div className="grid grid-4">
        {room.board.needs
          .filter((need) => need.required > 0)
          .map((need) => (
            <div key={need.position} className="card stat">
              <span className="stat-label">{need.position}</span>
              <span
                className={`stat-value ${need.urgency >= 1 ? 'down' : need.urgency > 0 ? 'warn' : 'up'}`}
                style={{ fontSize: 20 }}
              >
                {need.filled}/{need.required}
              </span>
              <span className="stat-note">
                {need.missing > 0
                  ? `${need.missing} slot${need.missing === 1 ? '' : 's'} to fill`
                  : need.flexEligible > 0
                    ? `covered · ${need.flexEligible} flex`
                    : 'covered'}
              </span>
            </div>
          ))}
      </div>

      {room.collisions.length > 0 && (
        <>
          <h2>Bye-week collisions</h2>
          <div className="card">
            {room.collisions.map((collision, i) => (
              <p key={i} style={{ margin: i === 0 ? 0 : '8px 0 0' }}>
                <span className="pill warn">Week {collision.week}</span>{' '}
                {collision.players.join(', ')} are all out at {collision.position} — you would be{' '}
                {collision.shortBy} short of filling the slot.
              </p>
            ))}
          </div>
        </>
      )}

      {watchlist.length > 0 && (
        <>
          <h2>Watchlist ({watchlist.length})</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Player</th>
                  <th>Pos</th>
                  <th className="num">Tier</th>
                  <th className="num">ADP</th>
                  <th className="num">Bye</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {watchlist.map((player) => (
                  <tr key={player.playerId}>
                    <td>
                      <WatchButton leagueId={leagueId} playerId={player.playerId} watching />
                    </td>
                    <td className="name">{player.name}</td>
                    <td className="faint">
                      {player.position}
                      {player.team ? ` · ${player.team}` : ''}
                    </td>
                    <td className="num">{player.tier ?? '—'}</td>
                    <td className="num dim">{player.adp ?? '—'}</td>
                    <td className="num faint">{player.byeWeek ?? '—'}</td>
                    <td>
                      {player.taken ? (
                        <span className="pill bad">gone · {player.takenBy}</span>
                      ) : (
                        <span className="pill good">available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Board</h2>
      <div className="nav" style={{ marginBottom: 12 }}>
        <a href={`?${hideTaken ? '' : 'hide=off'}`} aria-current={!pos ? 'page' : undefined}>
          All
        </a>
        {positions.map((position) => (
          <a
            key={position}
            href={`?pos=${position}${hideTaken ? '' : '&hide=off'}`}
            aria-current={pos === position ? 'page' : undefined}
          >
            {position}
          </a>
        ))}
        <a href={`?${pos ? `pos=${pos}&` : ''}${hideTaken ? 'hide=off' : ''}`}>
          {hideTaken ? 'Show drafted' : 'Hide drafted'}
        </a>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          <p>No players on the board yet.</p>
          <p className="faint" style={{ fontSize: 13 }}>
            Import draft history or load projections to populate it.
          </p>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th className="num">#</th>
                <th>Player</th>
                <th>Pos</th>
                <th className="num">Tier</th>
                <th className="num">Proj</th>
                <th className="num">VOR</th>
                <th className="num">ADP</th>
                <th className="num">Bye</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((player, index) => {
                const cliffs = room.board.cliffsByPosition[player.position] ?? [];
                const previous = visible[index - 1];
                // Mark the row where the tier changes: the cliff is the decision,
                // not the ordering within a tier.
                const isCliff =
                  previous !== undefined &&
                  previous.position === player.position &&
                  previous.tier !== null &&
                  player.tier !== null &&
                  player.tier !== previous.tier;
                const cliffGap = isCliff
                  ? cliffs.find((c) => c.startsAtIndex > 0)?.gap ?? null
                  : null;

                return (
                  <tr
                    key={player.playerId}
                    style={
                      isCliff
                        ? { borderTop: '2px solid var(--warn)' }
                        : player.taken
                          ? { opacity: 0.4 }
                          : undefined
                    }
                  >
                    <td>
                      <WatchButton
                        leagueId={leagueId}
                        playerId={player.playerId}
                        watching={player.onWatchlist}
                      />
                    </td>
                    <td className="num faint">{index + 1}</td>
                    <td className="name">
                      {player.taken ? <s>{player.name}</s> : player.name}
                      {player.taken && (
                        <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                          {player.takenBy} · pick {player.takenAtPick}
                        </span>
                      )}
                      {isCliff && cliffGap !== null && (
                        <span className="warn" style={{ fontSize: 11, display: 'block' }}>
                          tier cliff — {cliffGap} point drop
                        </span>
                      )}
                    </td>
                    <td className="faint">
                      {player.position}
                      {player.team ? ` · ${player.team}` : ''}
                    </td>
                    <td className="num">{player.tier ?? '—'}</td>
                    <td className="num">{player.projection ?? '—'}</td>
                    <td className="num dim">{player.vor ?? '—'}</td>
                    <td className="num dim">{player.adp ?? '—'}</td>
                    <td className="num faint">{player.byeWeek ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {room.market.length > 0 && (
        <>
          <h2>How this room drafts</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="num">First off the board</th>
                  <th className="num">Median round</th>
                  <th className="num">Picks</th>
                  <th className="num">Drafts</th>
                </tr>
              </thead>
              <tbody>
                {room.market.map((entry) => (
                  <tr key={entry.position}>
                    <td>{entry.position}</td>
                    <td className="num">round {entry.firstOffBoardRound}</td>
                    <td className="num dim">{entry.medianRound}</td>
                    <td className="num faint">{entry.count}</td>
                    <td className="num faint">{entry.drafts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            From {room.history.picks} picks across {room.history.seasons.length} season
            {room.history.seasons.length === 1 ? '' : 's'} ({room.history.seasons.join(', ')}). This
            is the number that survives roster turnover — the players change, the fact that this
            room lets tight ends fall does not.
          </p>
          <div style={{ marginTop: 12 }}>
            <ImportDraftsButton leagueId={leagueId} />
          </div>
        </>
      )}
    </main>
  );
}

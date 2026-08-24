import { notFound } from 'next/navigation';
import { getLeague } from '@/lib/db/queries';
import { scoringProfile } from '@/lib/compute/scoring';
import { LeagueNav } from '../nav';

export const dynamic = 'force-dynamic';

/**
 * War room. Dormant eleven months a year, so this ships as the scoring-aware
 * shell plus the pieces that are genuinely ready: the league's own scoring
 * profile, which is what makes its board different from the generic one, and
 * the tendency-mining engine behind it (lib/warroom/tendencies.ts).
 *
 * The live board, run detector and 5-second draft sync land before next August.
 */
export default async function WarRoomPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const league = await getLeague(leagueId);
  if (!league) notFound();

  const profile = scoringProfile(league.scoring_settings, league.roster_positions);
  const starters = league.roster_positions.filter((slot) => !['BN', 'IR', 'TAXI'].includes(slot));

  return (
    <main>
      <h1>War room</h1>
      <p className="lede">{league.name}</p>
      <LeagueNav leagueId={leagueId} />

      <div className="notice info">
        <strong>Preseason module.</strong> The live board, run detector and draft sync are
        scheduled for the offseason build. What is wired up now is the scoring profile the
        board will be re-scored against, and the tendency-mining engine that reads your
        league&apos;s prior drafts.
      </div>

      <h2>Your league is not the generic board</h2>
      <div className="grid grid-4">
        <div className="card stat">
          <span className="stat-label">Scoring</span>
          <span className="stat-value" style={{ fontSize: 17 }}>
            {profile.ppr >= 1 ? 'Full PPR' : profile.ppr > 0 ? `${profile.ppr} PPR` : 'Standard'}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">TE premium</span>
          <span className="stat-value" style={{ fontSize: 17 }}>
            {profile.tePremium > 0 ? `+${profile.tePremium}` : 'none'}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Pass TD</span>
          <span className="stat-value" style={{ fontSize: 17 }}>
            {profile.passTdPoints} pts
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Superflex</span>
          <span className="stat-value" style={{ fontSize: 17 }}>
            {profile.isSuperflex ? 'yes' : 'no'}
          </span>
        </div>
      </div>

      <h2>Starting lineup</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {starters.map((slot, index) => (
            <span key={`${slot}-${index}`} className="pill">
              {slot}
            </span>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 13, margin: '12px 0 0' }}>
          {starters.length} starters. The optimal-lineup solver treats these as the slots of a
          bipartite matching, which is why flex eligibility never strands a required slot.
        </p>
      </div>

      <h2>What tendency mining will surface</h2>
      <div className="grid grid-2">
        <div className="card">
          <h3>Average draft position by position</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            The round each manager reaches for each position, across every prior draft this
            league has run. This is the metric behind the live warnings.
          </p>
        </div>
        <div className="card">
          <h3>Reach rate against ADP</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            How far ahead of consensus a manager habitually takes their guys, and who the
            worst offence was.
          </p>
        </div>
        <div className="card">
          <h3>NFL-team homerism</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            The team someone drafts from far more than 1-in-32 would predict. Above 15% of
            picks is a tell you can plan around.
          </p>
        </div>
        <div className="card">
          <h3>Run detection with survival odds</h3>
          <p className="dim" style={{ margin: 0, fontSize: 14 }}>
            Three backs in five picks, six picks until you are up, and the probability the
            tier survives that long.
          </p>
        </div>
      </div>

      {league.previous_league_id ? (
        <p className="faint" style={{ fontSize: 13, marginTop: 18 }}>
          This league chains back to a prior season, so tendency mining has history to work
          with as soon as the draft importer runs.
        </p>
      ) : (
        <p className="faint" style={{ fontSize: 13, marginTop: 18 }}>
          No previous season is linked on this league, so tendency mining starts from this
          year&apos;s draft only.
        </p>
      )}
    </main>
  );
}

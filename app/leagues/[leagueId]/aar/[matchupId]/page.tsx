import { notFound } from 'next/navigation';
import { buildAfterActionReport, VERDICT_COPY } from '@/lib/aar/build';
import { getLeague, getStatPacket, latestPacketWeek, oddsByMatchup } from '@/lib/db/queries';
import { LeagueNav } from '../../nav';
import { SwingChart } from './swing-chart';

export const dynamic = 'force-dynamic';

export default async function AarPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; matchupId: string }>;
  searchParams: Promise<{ manager?: string; week?: string }>;
}) {
  const { leagueId, matchupId } = await params;
  const { manager, week: weekParam } = await searchParams;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const week = weekParam ? Number(weekParam) : await latestPacketWeek(leagueId);
  if (!week) notFound();

  const packet = await getStatPacket(leagueId, week);
  if (!packet) notFound();

  const matchup = packet.matchups.find((m) => m.matchupId === Number(matchupId));
  if (!matchup) notFound();

  const managerName = manager ?? matchup.a;
  const snapshots = (await oddsByMatchup(leagueId, week))[Number(matchupId)] ?? [];

  const report = buildAfterActionReport({
    packet,
    matchupId: Number(matchupId),
    managerName,
    snapshots,
  });
  if (!report) notFound();

  const verdict = VERDICT_COPY[report.verdict];

  return (
    <main>
      <h1>After action report</h1>
      <p className="lede">
        {report.manager} vs {report.opponent} · week {report.week}
      </p>
      <LeagueNav leagueId={leagueId} />

      <h2>Verdict</h2>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span className={`pill ${report.won ? 'good' : 'bad'}`}>{verdict.label}</span>
          <span className="mono" style={{ fontSize: 20 }}>
            {report.score} — {report.opponentScore}
          </span>
        </div>
        <p className="dim" style={{ margin: '10px 0 0' }}>
          {verdict.explanation}
        </p>
        {report.coaching.counterfactual && (
          <p style={{ margin: '8px 0 0' }}>{report.coaching.counterfactual}</p>
        )}
      </div>

      <h2>Swing chart</h2>
      <SwingChart report={report} />
      {report.turningPoint && (
        <p className="dim" style={{ fontSize: 13, marginTop: 8 }}>
          <strong>Turning point.</strong> {report.turningPoint.description}
        </p>
      )}

      <h2>Coaching report</h2>
      <div className="grid grid-4">
        <div className="card stat">
          <span className="stat-label">Actual</span>
          <span className="stat-value">{report.coaching.actual}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Optimal</span>
          <span className="stat-value">{report.coaching.optimal}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Efficiency</span>
          <span className="stat-value">{Math.round(report.coaching.efficiency * 100)}%</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Left on bench</span>
          <span className={`stat-value ${report.coaching.pointsLeft > 0 ? 'down' : ''}`}>
            {report.coaching.pointsLeft}
          </span>
        </div>
      </div>

      {report.coaching.regrets.length > 0 && (
        <div className="card table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Should have started</th>
                <th className="num">Pts</th>
                <th>Instead of</th>
                <th className="num">Pts</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.coaching.regrets.map((regret) => (
                <tr key={regret.playerId}>
                  <td className="name">{regret.player}</td>
                  <td className="num">{regret.points}</td>
                  <td className="name dim">{regret.replacing ?? 'an empty slot'}</td>
                  <td className="num dim">{regret.replacingPoints}</td>
                  <td className="num down">−{regret.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Luck split</h2>
      <div className="card">
        <table>
          <tbody>
            <tr>
              <td>Your performance vs your season mean</td>
              <td className={`num ${report.luckSplit.ownVariance >= 0 ? 'up' : 'down'}`}>
                {report.luckSplit.ownVariance > 0 ? '+' : ''}
                {report.luckSplit.ownVariance}
              </td>
            </tr>
            <tr>
              <td>Their performance vs their season mean</td>
              <td className={`num ${report.luckSplit.opponentVariance >= 0 ? 'down' : 'up'}`}>
                {report.luckSplit.opponentVariance > 0 ? '+' : ''}
                {report.luckSplit.opponentVariance}
              </td>
            </tr>
            <tr>
              <td>Cost of lineup decisions</td>
              <td className="num down">
                {report.luckSplit.lineupCost > 0 ? `−${report.luckSplit.lineupCost}` : '0'}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Final margin</strong>
              </td>
              <td className={`num ${report.luckSplit.margin >= 0 ? 'up' : 'down'}`}>
                <strong>
                  {report.luckSplit.margin > 0 ? '+' : ''}
                  {report.luckSplit.margin}
                </strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {report.waiverRoi.length > 0 && (
        <>
          <h2>Waiver ROI</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Added</th>
                  <th className="num">Week</th>
                  <th className="num">Points since</th>
                  <th>Dropped</th>
                  <th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {report.waiverRoi.map((line) => (
                  <tr key={`${line.playerId}-${line.addedWeek}`}>
                    <td className="name">{line.player}</td>
                    <td className="num faint">{line.addedWeek}</td>
                    <td className="num">{line.pointsSinceAdd}</td>
                    <td className="name dim">{line.droppedPlayer ?? '—'}</td>
                    <td className={`num ${line.roi >= 0 ? 'up' : 'down'}`}>
                      {line.roi > 0 ? '+' : ''}
                      {line.roi}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {report.nextWeek && (
        <>
          <h2>Next week</h2>
          <div className="card">
            <h3>
              {report.nextWeek.a} vs {report.nextWeek.b}
            </h3>
            <p className="faint" style={{ margin: 0, fontSize: 13 }}>
              {report.nextWeek.openingLine
                ? `Opening line: ${Math.round(report.nextWeek.openingLine.winProbA * 100)}% ${report.nextWeek.a}`
                : 'No opening line — a projection source is needed to price next week.'}
            </p>
          </div>
        </>
      )}
    </main>
  );
}

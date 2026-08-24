import { notFound } from 'next/navigation';
import { getLeague, getReport, latestPacketWeek, listManagers } from '@/lib/db/queries';
import { HEAT_PROFILES, parseHeatLevel } from '@/lib/report/heat';
import { VOICE_PRESETS, parseVoice } from '@/lib/report/voices';
import { LeagueNav } from '../nav';
import { ReportControls } from './controls';

export const dynamic = 'force-dynamic';

export default async function ReportPage({
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

  const week = weekParam ? Number(weekParam) : await latestPacketWeek(leagueId);
  const existing = week ? await getReport(leagueId, week, 'commissioner') : null;
  const managers = await listManagers(leagueId);

  const heat = HEAT_PROFILES[parseHeatLevel(league.heat_ceiling)];
  const voice = VOICE_PRESETS[parseVoice(league.voice_preset)];
  const optedDown = managers.filter((m) => m.roast_opt_down);

  const stats = existing?.fact_check_status as
    | { sentences?: number; cutSentences?: number; failureRate?: number }
    | undefined;

  return (
    <main>
      <h1>Commissioner&apos;s Report</h1>
      <p className="lede">
        {league.name}
        {week ? ` · week ${week}` : ''}
      </p>
      <LeagueNav leagueId={leagueId} />

      <ReportControls
        leagueId={leagueId}
        week={week}
        heat={league.heat_ceiling}
        voice={league.voice_preset}
        hasReport={Boolean(existing)}
      />

      <div className="odds-meta" style={{ marginTop: 14 }}>
        <span className="pill">{heat.label}</span>
        <span className="pill">{voice.label}</span>
        {optedDown.length > 0 && (
          <span className="pill warn">
            {optedDown.length} opted down: {optedDown.map((m) => m.display_name).join(', ')}
          </span>
        )}
      </div>

      {!week ? (
        <div className="empty">
          <p>No stat packet yet, so there is nothing to write about.</p>
        </div>
      ) : !existing ? (
        <div className="empty">
          <p>No report generated for week {week}.</p>
          <p className="faint" style={{ fontSize: 13 }}>
            Generation runs three passes: angle selection, writing, then a deterministic fact
            check against the stat packet.
          </p>
        </div>
      ) : (
        <>
          {stats && stats.cutSentences ? (
            <div className="notice" style={{ marginTop: 18 }}>
              <strong>
                {stats.cutSentences} of {stats.sentences} sentences were cut
              </strong>{' '}
              by the fact check — they carried numbers or attributions the stat packet does not
              support. A rising rate here means the packet schema and the prompt have drifted
              apart.
            </div>
          ) : null}

          <article className="report" style={{ marginTop: 22 }}>
            {renderMarkdown(existing.body)}
          </article>

          <p className="faint" style={{ fontSize: 12, marginTop: 30 }}>
            Generated {new Date(existing.generated_at).toLocaleString()}. Every number above
            was verified against the week {week} stat packet before this was shown.
          </p>
        </>
      )}
    </main>
  );
}

/**
 * Minimal markdown rendering. The report is produced by our own pipeline in a
 * known subset — headings, paragraphs, lists, bold — so a full parser would be
 * more surface area than the job needs.
 */
function renderMarkdown(body: string): React.ReactNode {
  const blocks = body.split(/\n\n+/);

  return blocks.map((block, index) => {
    const trimmed = block.trim();
    if (!trimmed) return null;

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) return <h2 key={index}>{heading[2]}</h2>;

    if (/^[ \t]*([-*+]|\d+[.)])[ \t]+/m.test(trimmed)) {
      const items = trimmed
        .split('\n')
        .map((line) => line.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/, '').trim())
        .filter(Boolean);
      return (
        <ul key={index}>
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      );
    }

    return <p key={index}>{inline(trimmed)}</p>;
  });
}

function inline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    return bold ? <strong key={i}>{bold[1]}</strong> : <span key={i}>{part}</span>;
  });
}

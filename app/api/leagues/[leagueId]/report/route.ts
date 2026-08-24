import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AnthropicGenerator } from '@/lib/anthropic/client';
import {
  getLeague,
  getStatPacket,
  listManagers,
  listStorylines,
  saveReport,
  saveStorylines,
  updateLeagueSettings,
} from '@/lib/db/queries';
import { awardCountsThrough } from '@/lib/jobs/packet';
import { activeStorylines, applyStorylineUpdates, generateCommissionersReport } from '@/lib/report/generate';
import { parseHeatLevel } from '@/lib/report/heat';
import { parseVoice } from '@/lib/report/voices';
import { formatFor, type DeliveryTarget } from '@/lib/report/delivery';

export const dynamic = 'force-dynamic';
/**
 * The Hobby ceiling. Three model passes over a full stat packet is genuinely
 * tight inside it, so generation is given a deadline and drops the storyline
 * pass rather than being killed with the report already written but unsaved.
 * On a plan allowing longer functions, raise this to 300 and the deadline with
 * it.
 */
export const maxDuration = 60;

const Body = z.object({
  week: z.number().int().min(1).max(22),
  heatCeiling: z.string().optional(),
  voice: z.string().optional(),
  /** Also return the report rendered for a delivery target. */
  target: z.enum(['sleeper', 'email', 'discord', 'slack', 'plain']).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const league = await getLeague(leagueId);
  if (!league) return NextResponse.json({ error: 'Unknown league.' }, { status: 404 });

  const packet = await getStatPacket(leagueId, parsed.week);
  if (!packet) {
    return NextResponse.json(
      { error: `No stat packet for week ${parsed.week}. Compute it first.` },
      { status: 409 },
    );
  }

  const heatCeiling = parseHeatLevel(parsed.heatCeiling ?? league.heat_ceiling);
  const voice = parseVoice(parsed.voice ?? league.voice_preset);

  // A heat or voice choice made here becomes the league's setting, so the next
  // week's scheduled run keeps it without the commissioner setting it twice.
  if (parsed.heatCeiling || parsed.voice) {
    await updateLeagueSettings(leagueId, { heatCeiling, voicePreset: voice });
  }

  const [managers, storedStorylines, seasonAwardCounts] = await Promise.all([
    listManagers(leagueId),
    listStorylines(leagueId, league.season),
    awardCountsThrough(league, parsed.week),
  ]);

  try {
    const result = await generateCommissionersReport({
      packet,
      storylines: activeStorylines(storedStorylines, parsed.week),
      seasonAwardCounts,
      heatCeiling,
      voice,
      managers: managers.map((m) => ({
        manager: m.display_name,
        roastOptDown: m.roast_opt_down,
      })),
      generator: new AnthropicGenerator(),
      // Leave room to persist the report and the storylines after the model
      // passes return. Losing a finished report to a timeout is the worst
      // outcome here: it costs the API spend and shows the user nothing.
      deadline: Date.now() + (maxDuration - 12) * 1000,
    });

    await saveReport({
      leagueId,
      week: parsed.week,
      kind: 'commissioner',
      variant: '',
      body: result.body,
      factCheckStatus: {
        ...result.factCheck.stats,
        violations: result.factCheck.violations.map((v) => ({ kind: v.kind, detail: v.detail })),
        voice,
        heatCeiling,
      },
    });

    await saveStorylines(
      leagueId,
      league.season,
      applyStorylineUpdates(storedStorylines, result.storylines, parsed.week),
    );

    return NextResponse.json({
      week: parsed.week,
      body: result.body,
      factCheck: result.factCheck.stats,
      violations: result.factCheck.violations,
      angles: result.angles.angles.map((angle) => angle.headline),
      delivery: parsed.target
        ? formatFor(parsed.target as DeliveryTarget, result.body, packet)
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

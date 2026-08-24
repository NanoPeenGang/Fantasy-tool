'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { HEAT_PROFILES, HEAT_LEVELS } from '@/lib/report/heat';
import { VOICE_KEYS, VOICE_PRESETS } from '@/lib/report/voices';

export function ReportControls({
  leagueId,
  week,
  heat,
  voice,
  hasReport,
}: {
  leagueId: string;
  week: number | null;
  heat: string;
  voice: string;
  hasReport: boolean;
}) {
  const router = useRouter();
  const [selectedHeat, setHeat] = useState(heat);
  const [selectedVoice, setVoice] = useState(voice);
  const [status, setStatus] = useState<'idle' | 'working'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function generate() {
    if (!week) return;
    setStatus('working');
    setMessage(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week, heatCeiling: selectedHeat, voice: selectedVoice }),
      });
      const body = await response.json();

      if (!response.ok) {
        setMessage(body.error ?? 'Generation failed.');
        setStatus('idle');
        return;
      }
      router.refresh();
    } catch {
      setMessage('Could not reach the server.');
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="grid grid-3">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="heat">Heat ceiling</label>
          <select id="heat" value={selectedHeat} onChange={(e) => setHeat(e.target.value)}>
            {HEAT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {HEAT_PROFILES[level].label}
              </option>
            ))}
          </select>
          <span className="faint" style={{ fontSize: 12 }}>
            Managers can opt down from this, never up.
          </span>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="voice">Voice</label>
          <select id="voice" value={selectedVoice} onChange={(e) => setVoice(e.target.value)}>
            {VOICE_KEYS.map((key) => (
              <option key={key} value={key}>
                {VOICE_PRESETS[key].label}
              </option>
            ))}
          </select>
          <span className="faint" style={{ fontSize: 12 }}>
            Changes diction only. The facts are identical across voices.
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button type="button" onClick={generate} disabled={!week || status === 'working'}>
            {status === 'working' ? 'Generating…' : hasReport ? 'Regenerate' : 'Generate report'}
          </button>
        </div>
      </div>

      {message && (
        <p className="down" style={{ fontSize: 13, margin: '10px 0 0' }}>
          {message}
        </p>
      )}
    </div>
  );
}

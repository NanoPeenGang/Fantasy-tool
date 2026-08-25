'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Pull this room's draft history from Sleeper. Safe to re-run. */
export function ImportDraftsButton({ leagueId }: { leagueId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'ok' | 'error'>('ok');

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/leagues/${leagueId}/draft/import`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setTone('error');
        setMessage(body.error ?? 'Import failed.');
        return;
      }
      setTone('ok');
      setMessage(
        `Imported ${body.picks} picks across ${body.drafts} draft${body.drafts === 1 ? '' : 's'}` +
          (body.seasons.length ? ` (${body.seasons.join(', ')}).` : '.'),
      );
      router.refresh();
    } catch {
      setTone('error');
      setMessage('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="secondary" onClick={run} disabled={busy}>
        {busy ? 'Importing…' : 'Import draft history'}
      </button>
      {message && (
        <p className={tone === 'ok' ? 'up' : 'down'} style={{ fontSize: 13, margin: '8px 0 0' }}>
          {message}
        </p>
      )}
    </div>
  );
}

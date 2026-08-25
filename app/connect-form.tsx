'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type SetupState = 'ready' | 'not_configured' | 'unreachable' | 'not_migrated';

/**
 * The connect form.
 *
 * The input is never disabled, even when setup is incomplete. A disabled text
 * box gives no feedback when you click it — it just refuses, and there is
 * nowhere to go from there. Letting someone type and then telling them exactly
 * what is wrong (and offering the button that fixes it) is strictly better than
 * silently locking the page.
 */
export function ConnectForm({ setup }: { setup: SetupState }) {
  const router = useRouter();
  const [leagueId, setLeagueId] = useState('');
  const [busy, setBusy] = useState<null | 'connecting' | 'migrating'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'error' | 'ok'>('error');

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy('connecting');
    setMessage(null);

    try {
      const response = await fetch('/api/leagues/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sleeperLeagueId: leagueId.trim() }),
      });
      const body = await response.json();

      if (!response.ok) {
        setTone('error');
        setMessage(body.error ?? 'Could not connect that league.');
        return;
      }
      router.push(`/leagues/${body.leagueId}`);
    } catch {
      setTone('error');
      setMessage('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function migrate() {
    setBusy('migrating');
    setMessage(null);

    try {
      const response = await fetch('/api/admin/migrate', { method: 'POST' });
      const body = await response.json();

      if (!response.ok) {
        setTone('error');
        setMessage(body.error ?? 'Could not create the schema.');
        return;
      }
      setTone('ok');
      setMessage('Schema created. You can connect a league now.');
      router.refresh();
    } catch {
      setTone('error');
      setMessage('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={connect}>
      <div className="field">
        <label htmlFor="leagueId">Sleeper league ID</label>
        <input
          id="leagueId"
          type="text"
          inputMode="numeric"
          placeholder="1048278306688581632"
          value={leagueId}
          onChange={(event) => setLeagueId(event.target.value)}
          autoComplete="off"
        />
        <span className="faint" style={{ fontSize: 12 }}>
          It is the long number in your league&apos;s Sleeper URL.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy !== null || leagueId.trim() === ''}>
          {busy === 'connecting' ? 'Connecting…' : 'Connect'}
        </button>

        {setup === 'not_migrated' && (
          <button type="button" className="secondary" onClick={migrate} disabled={busy !== null}>
            {busy === 'migrating' ? 'Running migration…' : 'Create / update the schema'}
          </button>
        )}
      </div>

      {setup === 'not_migrated' && !message && (
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
          The database is connected but empty. Create the schema once, then connect a league.
        </p>
      )}

      {message && (
        <p
          className={tone === 'ok' ? 'up' : 'down'}
          style={{ fontSize: 13, margin: '10px 0 0' }}
        >
          {message}
        </p>
      )}
    </form>
  );
}

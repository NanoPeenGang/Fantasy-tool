'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ConnectForm({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [leagueId, setLeagueId] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('working');
    setMessage(null);

    try {
      const response = await fetch('/api/leagues/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sleeperLeagueId: leagueId.trim() }),
      });
      const body = await response.json();

      if (!response.ok) {
        setStatus('error');
        setMessage(body.error ?? 'Could not connect that league.');
        return;
      }
      router.push(`/leagues/${body.leagueId}`);
    } catch {
      setStatus('error');
      setMessage('Could not reach the server.');
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="leagueId">Sleeper league ID</label>
        <input
          id="leagueId"
          type="text"
          inputMode="numeric"
          placeholder="1048278306688581632"
          value={leagueId}
          onChange={(event) => setLeagueId(event.target.value)}
          disabled={disabled || status === 'working'}
        />
        <span className="faint" style={{ fontSize: 12 }}>
          It is the long number in your league&apos;s Sleeper URL.
        </span>
      </div>

      <button type="submit" disabled={disabled || status === 'working' || leagueId.trim() === ''}>
        {status === 'working' ? 'Connecting…' : 'Connect'}
      </button>

      {message && (
        <p className="down" style={{ fontSize: 13, marginBottom: 0 }}>
          {message}
        </p>
      )}
    </form>
  );
}

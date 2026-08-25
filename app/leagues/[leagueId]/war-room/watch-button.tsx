'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Add or remove a player from the watchlist without leaving the board. */
export function WatchButton({
  leagueId,
  playerId,
  watching,
}: {
  leagueId: string;
  playerId: string;
  watching: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(watching);

  async function toggle() {
    setBusy(true);
    // Optimistic: the board is long and a round trip per star makes it feel
    // broken. A failure reverts and the refresh below reconciles either way.
    const next = !on;
    setOn(next);

    try {
      const response = next
        ? await fetch(`/api/leagues/${leagueId}/watchlist`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ playerId }),
          })
        : await fetch(
            `/api/leagues/${leagueId}/watchlist?playerId=${encodeURIComponent(playerId)}`,
            { method: 'DELETE' },
          );
      if (!response.ok) setOn(!next);
      else router.refresh();
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-label={on ? `Remove from watchlist` : `Add to watchlist`}
      aria-pressed={on}
      className="watch"
      style={{
        background: 'none',
        border: 'none',
        cursor: busy ? 'default' : 'pointer',
        color: on ? 'var(--warn)' : 'var(--text-faint)',
        fontSize: 16,
        lineHeight: 1,
        padding: '2px 4px',
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

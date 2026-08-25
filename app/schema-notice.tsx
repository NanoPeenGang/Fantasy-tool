'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Shown when the database is behind the code's schema.
 *
 * This is a distinct state from "no database" and from "no schema at all": the
 * app is connected, has data, and is simply missing tables a newer version
 * expects. The action is the same migration, but the framing matters — nobody
 * should go re-checking a connection string over a missing column.
 */
export function SchemaNotice({
  missingTables,
  leagueScoped,
}: {
  missingTables: string[];
  leagueScoped?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'ok' | 'error'>('ok');

  async function migrate() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/migrate', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setTone('error');
        setMessage(
          body.error ??
            'Could not update the schema. If CRON_SECRET is set, run the migration with it.',
        );
        return;
      }
      setTone('ok');
      setMessage('Schema updated.');
      router.refresh();
    } catch {
      setTone('error');
      setMessage('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice" style={{ marginTop: 18 }}>
      <strong>The database is behind this version of the app.</strong>{' '}
      {missingTables.length} table{missingTables.length === 1 ? ' is' : 's are'} missing, so
      {leagueScoped ? ' this page' : ' parts of the app'} cannot load:
      <div className="mono" style={{ fontSize: 12, margin: '8px 0' }}>
        {missingTables.join(', ')}
      </div>
      The migration only adds what is absent — it never drops or rewrites anything, so running it
      against a live database is safe.
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={migrate} disabled={busy}>
          {busy ? 'Updating…' : 'Update the schema'}
        </button>
      </div>
      {message && (
        <p className={tone === 'ok' ? 'up' : 'down'} style={{ fontSize: 13, margin: '10px 0 0' }}>
          {message}
        </p>
      )}
    </div>
  );
}

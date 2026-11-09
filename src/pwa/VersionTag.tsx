import { useEffect, useState } from 'react';
import { checkForUpdatesNow } from './updates';

/** Entry bundle this page is running, e.g. "main-Cg4-M3cw.js" (unique per build). */
export function runningEntry(doc: Document = document): string | null {
  const s = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  const m = s?.src.match(/\/assets\/([^/?#]+\.js)/);
  return m ? m[1] : null;
}

/**
 * "גרסה <id>" of the build this device RUNS (its entry bundle), compared with the server's
 * /app-version.json: if the server already has a newer build, say so and start the update.
 * Lets the owner confirm a fix actually reached the phone.
 */
export function VersionTag({ className = '' }: { className?: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const entry = runningEntry();
    if (!entry) return; // dev server
    const id = entry.replace(/^main-|\.js$/g, '');
    setText(`גרסה ${id}`);
    let on = true;
    fetch('/app-version.json', { cache: 'no-store' })
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j: { builtAt?: string; inline?: Record<string, string> } | null) => {
        if (!on || !j) return;
        const idx = j.inline?.['index.html'] ?? '';
        const current = idx ? idx.includes(entry) : true;
        const d = j.builtAt ? new Date(j.builtAt) : null;
        const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        if (current) setText(`גרסה ${id}${when ? ` · ${when}` : ''} · מעודכנת`);
        else {
          setText(`גרסה ${id} · יש גרסה חדשה${when ? ` (${when})` : ''} — מעדכן…`);
          void checkForUpdatesNow();
        }
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  if (!text) return null;
  return (
    <span className={className} data-testid="version-tag" dir="rtl">
      {text}
    </span>
  );
}

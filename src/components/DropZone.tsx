import { useRef, useState } from 'react';
import { IconFilePdf } from './ui/icons';
import { DriveOpenButton } from '../drive/DriveUi';
import { UpdateCheckButton } from '../pwa/UpdateToast';

interface Props {
  /** Several files: the first is opened, the rest are added to the workspace. */
  onFiles(files: File[]): void;
}

/** Full-area empty state: drag & drop or click to choose one or more PDFs. */
export default function DropZone({ onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  async function openDemo() {
    setDemoLoading(true);
    setDemoError(null);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}demo-facade.pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      onFiles([new File([blob], 'demo-facade.pdf', { type: 'application/pdf', lastModified: 0 /* stable key so saved measurements restore */ })]);
    } catch {
      setDemoError('טעינת קובץ הדוגמה נכשלה');
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
      <figure className="flex shrink-0 select-none flex-col items-center opacity-90" aria-label="Professional Document Solutions">
        {/* Line-art mark only (no "PDF" caption) + tagline as text, like the login / download pages. */}
        <img
          src={`${import.meta.env.BASE_URL}icons/logo-mark-white.png`}
          srcSet={`${import.meta.env.BASE_URL}icons/logo-mark-white.png 560w, ${import.meta.env.BASE_URL}icons/logo-mark-white@2x.png 1120w`}
          sizes="13rem"
          alt=""
          width={560}
          height={363}
          draggable={false}
          className="h-auto w-40 sm:w-52"
        />
        <figcaption className="mt-1.5 text-center text-[10px] font-medium uppercase tracking-[0.18em] text-slate-300 sm:text-[11px]" aria-hidden="true">
          Professional Document Solutions
        </figcaption>
      </figure>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          // preventDefault marks it handled; App's window-level drop handler skips it.
          e.preventDefault();
          setOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) onFiles(files);
        }}
        className={
          'flex h-full max-h-[28rem] w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ' +
          (over
            ? 'border-sky-400 bg-sky-900/20 text-sky-200'
            : 'border-slate-600 bg-slate-800/40 text-slate-300 hover:border-slate-400 hover:bg-slate-800/70')
        }
      >
        <IconFilePdf size={56} className={over ? 'text-sky-400' : 'text-slate-500'} />
        <div className="text-xl font-semibold">גרור קובצי PDF לכאן או לחץ לבחירה</div>
        <div className="max-w-md text-center text-sm text-slate-400">
          תוכניות אדריכליות, חזיתות וחתכים — גם קבצים כבדים. לאחר הפתיחה: כייל קנה מידה ומדוד שטחי חזית.
        </div>
      </button>
      <div className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={openDemo}
          disabled={demoLoading}
          className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-sky-500 hover:text-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-wait disabled:opacity-60"
        >
          {demoLoading ? 'טוען קובץ דוגמה…' : 'נסה עם קובץ לדוגמה'}
        </button>
        <DriveOpenButton />
        <div className="text-xs text-slate-500">בקובץ הדוגמה: קו המידה 10.00 מתאים לכיול</div>
        {demoError && <div className="text-xs text-red-400">{demoError}</div>}
      </div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        data-testid="dropzone-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <UpdateCheckButton className="absolute bottom-3 left-1/2 -translate-x-1/2" />
    </div>
  );
}

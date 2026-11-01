import { useRef, useState } from 'react';
import { IconFilePdf } from './ui/icons';

interface Props {
  onFile(file: File): void;
}

/** Full-area empty state: drag & drop or click to choose a PDF. */
export default function DropZone({ onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
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
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={
          'flex h-full max-h-[28rem] w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ' +
          (over
            ? 'border-sky-400 bg-sky-900/20 text-sky-200'
            : 'border-slate-600 bg-slate-800/40 text-slate-300 hover:border-slate-400 hover:bg-slate-800/70')
        }
      >
        <IconFilePdf size={56} className={over ? 'text-sky-400' : 'text-slate-500'} />
        <div className="text-xl font-semibold">גרור קובץ PDF לכאן או לחץ לבחירה</div>
        <div className="max-w-md text-center text-sm text-slate-400">
          תוכניות אדריכליות, חזיתות וחתכים — גם קבצים כבדים. לאחר הפתיחה: כייל קנה מידה ומדוד שטחי חזית.
        </div>
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

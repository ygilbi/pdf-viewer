import type { GilboaMeasure, GilboaPayload } from './gilboaExport';

/**
 * "ייצא ל-ALOO" → the takeoff items as a tab-separated table, ready to paste into ALOO's
 * "ייבוא מדידות" (📋 הדבק מהלוח) — and into Excel / Google Sheets as well.
 *
 * Contract (ALOO src/features/takeoff/takeoff.ts · parseTakeoffText): a header row with exactly
 * "סוג" and "שם"; other columns are found by prefix (קטגוריה, עמוד, שטח, היקף, אורך, כמות, רוחב,
 * גובה); kinds in Hebrew (שטח / פתח / אורך / ספירה); plain numbers (metres / m², dot decimals).
 */

export const ALOO_KIND_LABEL: Record<GilboaMeasure['kind'], string> = { area: 'שטח', deduct: 'פתח', length: 'אורך', count: 'ספירה' };

export const ALOO_COLUMNS = ['מס׳', 'סוג', 'שם', 'קטגוריה', 'עמוד', 'שטח (מ״ר)', 'היקף (מ׳)', 'אורך (מ׳)', 'כמות', 'רוחב (מ׳)', 'גובה (מ׳)'] as const;

/** A cell: no tabs / line breaks inside (they would split the table). */
const cell = (v: string | number | null | undefined) => (v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim());
const n = (v: number | null) => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v * 1000) / 1000));

export function buildAlooTsv(p: GilboaPayload): string {
  const rows = [ALOO_COLUMNS.join('\t')];
  p.measurements.forEach((m, i) => {
    rows.push(
      [
        String(i + 1),
        ALOO_KIND_LABEL[m.kind],
        cell(m.label),
        cell(m.category),
        String(m.page),
        n(m.areaM2),
        n(m.perimeterM),
        n(m.lengthM),
        m.count == null ? '' : String(m.count),
        n(m.widthM),
        n(m.heightM),
      ].join('\t'),
    );
  });
  return rows.join('\n') + '\n';
}

/** Writes text to the clipboard (Clipboard API, else a hidden textarea + execCommand). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

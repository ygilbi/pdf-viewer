import type { ToolId } from '../../core/types';

/**
 * Contextual step prompts for the bottom-left hint panel (AutoCAD command-line style):
 * one bold step line + 1–2 short option lines. Pure: everything comes in through `HintInput`
 * so the wording can be unit-tested without a DOM or the stores.
 */
export interface HintInput {
  tool: ToolId;
  /** Points placed by the active tool (calibrate / polygon / length / first rect corner). */
  draftLength: number;
  /** The current page has a scale. */
  calibrated: boolean;
  /** Coarse pointer (phone / tablet): touch wording, no keyboard keys. */
  touch: boolean;
  snapEnabled: boolean;
  /** Count group waiting for its width × height measurement (label), if any. */
  countMeasuringLabel: string | null;
  /** Count group being marked on this page (label), if any. */
  activeCountLabel: string | null;
  /** Label of the selected item (pan tool), if any. */
  selectedLabel: string | null;
  /** Kind of the annotation whose text / target is being edited in place, if any. */
  editingKind: string | null;
  searchOpen: boolean;
}

export interface Hint {
  /** Bold step line. */
  title: string;
  /** Option lines (keys / alternatives). */
  lines: string[];
  /** Step blocked (uncalibrated page): shown in amber. */
  warn?: boolean;
  /** Inline action button. */
  action?: 'countSkip';
}

const MEASURE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['area', 'rectArea', 'deduct', 'rectDeduct', 'length']);
const SNAP_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['area', 'rectArea', 'deduct', 'rectDeduct', 'length', 'calibrate', 'count']);

const SHAPE_NAMES: Partial<Record<ToolId, string>> = {
  rect: 'מלבן',
  ellipse: 'אליפסה',
  triangle: 'משולש',
  diamond: 'מעוין',
  cloud: 'ענן',
};
const SHAPE_SHIFT: Partial<Record<ToolId, string>> = {
  rect: 'Shift: ריבוע',
  ellipse: 'Shift: עיגול',
  triangle: 'Shift: שווה צלעות',
  diamond: 'Shift: ריבועי',
};

export const UNCALIBRATED_TITLE = 'הדף לא מכויל — כייל קודם (C) או החל קנ״מ שזוהה';
const UNCALIBRATED_TITLE_TOUCH = 'הדף לא מכויל — כייל קודם או החל קנ״מ שזוהה';

const join = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');

function snapLine(i: HintInput): string | null {
  if (!SNAP_TOOLS.has(i.tool)) return null;
  if (i.touch) return i.snapEnabled ? 'הצמדה לקווי השרטוט פעילה' : null;
  return i.snapEnabled ? 'הצמדה פעילה · S כיבוי · Ctrl עקיפה רגעית' : 'הצמדה כבויה · S להפעלה';
}

/** Steps of the polygon / rectangle / length tools (without the calibration warning). */
function measureSteps(i: HintInput): Hint {
  const { tool, draftLength: d, touch } = i;
  const esc = touch ? null : 'Esc יציאה';
  const back = touch ? null : 'Backspace נקודה אחורה';
  if (tool === 'rectArea' || tool === 'rectDeduct') {
    const what = tool === 'rectDeduct' ? 'הפתח' : 'השטח';
    return d === 0
      ? { title: `${touch ? 'הקש' : 'לחץ'} על פינה של ${what} (או גרור מלבן)`, lines: [join(touch ? 'אחר כך על הפינה הנגדית' : 'אחר כך לחיצה בפינה הנגדית', esc)] }
      : { title: `${touch ? 'הקש' : 'לחץ'} על הפינה הנגדית`, lines: [join(touch ? null : 'Backspace פינה אחורה', esc)] };
  }
  if (tool === 'length') {
    const title = d === 0 ? `${touch ? 'הקש' : 'לחץ'} על נקודת ההתחלה` : `${touch ? 'הקש' : 'לחץ'} על הנקודה הבאה`;
    const line = touch
      ? d >= 2
        ? 'הקשה כפולה לסיום'
        : 'הקש על כל נקודה לאורך הקו'
      : join(d >= 2 ? 'Enter / לחיצה כפולה לסיום' : 'לחיצה כפולה / Enter לסיום', back, esc);
    return { title, lines: [line] };
  }
  // area / deduct (polygon)
  const corners = tool === 'deduct' ? 'פינות הפתח' : 'פינות השטח';
  const tap = touch ? 'הקש' : 'לחץ';
  const title =
    d === 0
      ? `סמן את ${corners} — ${tap} על הפינה הראשונה`
      : d < 3
        ? `${tap} על הפינה הבאה`
        : `${tap} על הפינה הבאה, או על הנקודה הראשונה לסגירה`;
  const line = touch
    ? d >= 3
      ? 'הקש על הנקודה הראשונה או הקשה כפולה לסגירה'
      : 'הקש על כל פינה בתורה'
    : join('Enter לסגירה', back, esc);
  const lines = [line];
  if (tool === 'deduct' && d === 0 && !touch) lines.push('Alt+לחיצה: פתח מלבני בשתי פינות');
  return { title, lines };
}

/** State → the current step's prompt (null = nothing to explain). */
export function computeHint(i: HintInput): Hint | null {
  const { tool, touch } = i;
  const tap = touch ? 'הקש' : 'לחץ';

  // In-place editing of a note / text / link target wins over everything.
  if (i.editingKind) {
    if (i.editingKind === 'link')
      return { title: 'בחר את עמוד היעד של הקישור', lines: [touch ? 'אשר לשמירה · ביטול מוחק קישור חדש' : 'Enter שמירה · Esc ביטול'] };
    return {
      title: i.editingKind === 'note' ? 'הקלד את תוכן ההערה' : 'הקלד את הטקסט',
      lines: [touch ? 'הקש מחוץ לתיבה לסיום' : 'Enter לסיום · Shift+Enter שורה חדשה · Esc ביטול'],
    };
  }

  if (tool === 'count') {
    if (i.countMeasuringLabel) {
      return {
        title:
          i.draftLength > 0
            ? `מדוד את ${i.countMeasuringLabel}: ${tap} על הפינה הנגדית`
            : `מדוד את ${i.countMeasuringLabel}: ${tap} על שתי פינות נגדיות (או גרור)`,
        lines: ['המידות (רוחב × גובה) נכנסות לטבלת הפריטים · אין צורך? דלג'],
        action: 'countSkip',
      };
    }
    if (i.activeCountLabel) {
      return {
        title: `סמן עוד פריטים מסוג ${i.activeCountLabel}`,
        lines: [
          touch ? `הקש על כל פריט זהה · "סיום" לפריט הבא` : 'Enter / סיום לפריט הבא · Backspace מחיקת האחרון · Esc יציאה',
        ],
      };
    }
    const lines = ['אחר כך תמדוד אותו פעם אחת ותסמן את כל הזהים לו'];
    if (!i.calibrated) lines[0] = 'הדף לא מכויל — הספירה תעבוד, אבל בלי מידות';
    return { title: `${tap} על הפריט הראשון שברצונך לספור`, lines };
  }

  if (MEASURE_TOOLS.has(tool)) {
    const steps = measureSteps(i);
    if (!i.calibrated) {
      return {
        title: touch ? UNCALIBRATED_TITLE_TOUCH : UNCALIBRATED_TITLE,
        lines: [touch ? 'בחר "כיול ידני" בסרגל הכלים, או הקש על הקנ״מ שזוהה למעלה' : 'סמן מידה ידועה בכלי הכיול, או לחץ על הקנ״מ שזוהה למעלה'],
        warn: true,
      };
    }
    const snap = snapLine(i);
    if (snap) steps.lines.push(snap);
    return steps;
  }

  if (tool === 'calibrate') {
    const d = i.draftLength;
    if (d >= 2) return { title: 'הזן אורך ידוע (מ׳) ואשר', lines: [touch ? 'אישור לשמירת הכיול · ביטול לסימון מחדש' : 'Enter אישור · Esc ביטול'] };
    const hint: Hint =
      d === 0
        ? { title: `כיול 1/2: ${tap} על תחילת מידה ידועה`, lines: ['בחר קו שאורכו רשום בשרטוט — ככל שארוך יותר, מדויק יותר'] }
        : { title: `כיול 2/2: ${tap} על סוף המידה`, lines: [touch ? 'אחר כך תזין את האורך האמיתי' : 'Backspace נקודה אחורה · Esc יציאה'] };
    const snap = snapLine(i);
    if (snap) hint.lines.push(snap);
    return hint;
  }

  if (tool === 'note' || tool === 'text') {
    const what = tool === 'note' ? 'הערה' : 'טקסט';
    return { title: `${tap} במקום שבו תופיע ה${what}`, lines: [`${tap === 'הקש' ? 'הקשה' : 'לחיצה'} על ${what} קיימת לעריכה${touch ? '' : ' · Esc יציאה'}`] };
  }

  const shape = SHAPE_NAMES[tool];
  if (shape) return { title: `גרור לציור ${shape}`, lines: [touch ? 'גרור מפינה לפינה' : join(SHAPE_SHIFT[tool], 'Esc יציאה')] };
  if (tool === 'line') return { title: 'גרור מנקודה לנקודה', lines: [touch ? 'גרור מקצה לקצה' : 'Shift: נעילה כל 30° · Esc יציאה'] };
  if (tool === 'arrow') return { title: 'גרור מהזנב לראש החץ', lines: [touch ? 'הראש נוצר בנקודה שבה משחררים' : 'Shift: נעילה כל 45° · Esc יציאה'] };
  if (tool === 'pen')
    return {
      title: 'גרור לציור חופשי',
      lines: [touch ? 'החזק במקום בסוף הקו → יתיישר לקו ישר' : 'Shift לחוץ: קו ישר כל 30° · החזקה במקום: יישור לקו'],
    };
  if (tool === 'highlight') return { title: 'גרור מלבן להדגשה', lines: [touch ? 'מסמן שקוף מעל השרטוט' : 'מסמן שקוף מעל השרטוט · Esc יציאה'] };
  if (tool === 'link')
    return { title: 'גרור אזור לחיץ ובחר עמוד יעד', lines: [`${touch ? 'הקשה' : 'לחיצה'} על קישור קיים לעריכה · בכלי יד היא עוברת לעמוד`] };

  // pan
  if (i.searchOpen)
    return { title: 'חיפוש וספירה: הקלד מילה או תגית (למשל W1)', lines: [touch ? 'הקש על תוצאה כדי לעבור אליה' : 'Enter חיפוש · F3 הבא · Shift+F3 הקודם'] };
  if (i.selectedLabel)
    return {
      title: `נבחר: ${i.selectedLabel}`,
      lines: [touch ? 'גרור להזזה · גרור נקודה לעריכה · הקש ברקע לביטול' : 'גרור להזזה · גרור נקודה לעריכה · Delete מחיקה · Esc ביטול'],
    };
  return touch
    ? { title: 'אצבע אחת להזזה · שתיים לזום', lines: ['בחר כלי מהסרגל כדי למדוד או לסמן'] }
    : { title: 'גרור להזזה · גלגלת = עמוד הבא · Ctrl+גלגלת = זום', lines: ['בחר כלי מהסרגל או מקש קיצור (A שטח · L אורך · N ספירה · C כיול)'] };
}

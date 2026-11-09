/**
 * Bring `el` into view inside its nearest scrolling container on ONE axis only.
 *
 * Element.scrollIntoView() scrolls every ancestor that can scroll — including the app's
 * `overflow: hidden` layout roots, which are scrollable by script. On a phone a drawer row
 * scrolled into view while the drawer was still sliding in shifted the whole app sideways and
 * left it stuck there. This only moves the list/strip the element lives in.
 */
export function scrollWithin(el: Element | null | undefined, axis: 'x' | 'y' = 'y'): void {
  if (!(el instanceof HTMLElement)) return;
  let c: HTMLElement | null = el.parentElement;
  while (c) {
    const cs = getComputedStyle(c);
    const ov = axis === 'y' ? cs.overflowY : cs.overflowX;
    if (ov === 'auto' || ov === 'scroll') break;
    c = c.parentElement;
  }
  if (!c) return;
  const er = el.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  if (axis === 'y') {
    if (er.top < cr.top) c.scrollTop -= cr.top - er.top;
    else if (er.bottom > cr.bottom) c.scrollTop += Math.min(er.bottom - cr.bottom, er.top - cr.top);
  } else {
    if (er.left < cr.left) c.scrollLeft -= cr.left - er.left;
    else if (er.right > cr.right) c.scrollLeft += Math.min(er.right - cr.right, er.left - cr.left);
  }
}

/**
 * Keep the app's fixed layout roots (marked `data-lock-scroll`) at scroll 0. Browsers can still
 * scroll `overflow: hidden` elements (focus, scrollIntoView, text selection); any such scroll on
 * a layout root is undone at once. Returns a cleanup function.
 */
export function lockLayoutScroll(doc: Document = document): () => void {
  const onScroll = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.hasAttribute('data-lock-scroll') && (t.scrollLeft || t.scrollTop)) {
      t.scrollLeft = 0;
      t.scrollTop = 0;
    } else if (t === doc && (doc.scrollingElement?.scrollLeft || doc.scrollingElement?.scrollTop)) {
      doc.scrollingElement.scrollLeft = 0;
      doc.scrollingElement.scrollTop = 0;
    }
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener('scroll', onScroll, { capture: true });
}

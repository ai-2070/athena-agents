// Message boxes grow with what's typed through CSS (`field-sizing-content`). Safari has no field-sizing (the macOS
// desktop app runs on Safari's engine), so there the boxes are sized here instead. Their min-h and max-h still apply.
const SELECTOR = 'textarea.field-sizing-content';

/** Sizes one box to its text. */
export function fitTextarea(t: HTMLTextAreaElement): void {
  t.style.height = 'auto';
  // border-box: the borders count in the height
  t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`;
}

const fitAll = (): void => document.querySelectorAll<HTMLTextAreaElement>(SELECTOR).forEach(fitTextarea);

/** Turns the fallback on where the browser can't do it itself. */
export function autosizeTextareas(
  supported = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'),
): boolean {
  if (supported) return false;
  document.addEventListener(
    'input',
    (e) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.matches(SELECTOR)) fitTextarea(e.target);
    },
    true,
  );
  // a box emptied from code (after sending) or a new one fires no input event: check them all after the next change
  let queued = false;
  const later = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fitAll();
    });
  };
  for (const type of ['keyup', 'click', 'focusin']) document.addEventListener(type, later, true);
  return true;
}

// Eve's wordmark. Inline, not an <img>, so it takes the text colour in light and dark.

// The wordmark is wide, so it is drawn at 70% of the height the other engines' marks fill; the box keeps their full
// height (the drawing centred in it), so a label under it lines up with theirs.
const PAD = (53 / 0.7 - 53) / 2;

/** size: the height of the other engines' marks. */
export function EveMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox={`0 ${-PAD} 169 ${53 + 2 * PAD}`}
      height={size}
      width={Math.round((size * 0.7 * 169) / 53)}
      aria-hidden="true"
      className="eve-mark block shrink-0"
    >
      <path
        fill="currentColor"
        d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z"
      />
      <path fill="currentColor" d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" />
    </svg>
  );
}

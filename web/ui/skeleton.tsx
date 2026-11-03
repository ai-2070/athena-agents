// Shapes where content will be while a page loads, so it doesn't jump when the content arrives.
// A shimmer passes over them (the global reduced-motion rule stops it).
import type { ReactNode } from 'react';

/** One grey shape. Size and roundness come from className (h-4 w-32, rounded-full…). */
export function Bone({ className = '' }: { className?: string }) {
  const round = /(^|\s)rounded-/.test(className) ? '' : 'rounded-ctl ';
  return <span aria-hidden="true" className={`block flex-none ${round}bg-[linear-gradient(90deg,var(--color-panel-2)_30%,var(--color-line)_50%,var(--color-panel-2)_70%)] bg-size-[200%_100%] animate-shimmer ${className}`.trim()} />;
}

/** A loading page: says what is loading to screen readers, and shows the shapes. */
export function Skeleton({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

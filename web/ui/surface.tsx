import type { ComponentPropsWithoutRef } from 'react';

/** A flat page surface; floating layers use the shared glass material instead. */
export function Plate({ className = '', ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={`glass-plate ${className}`.trim()} {...props} />;
}

/** A flat surface with section semantics. */
export function PlateSection({ className = '', ...props }: ComponentPropsWithoutRef<'section'>) {
  return <section className={`glass-plate ${className}`.trim()} {...props} />;
}

/** A navigable flat surface. */
export function PlateLink({ className = '', ...props }: ComponentPropsWithoutRef<'a'>) {
  return <a className={`glass-plate ${className}`.trim()} {...props} />;
}

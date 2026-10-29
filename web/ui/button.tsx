import type { ComponentPropsWithoutRef } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'plain';
type Size = 'default' | 'small' | 'tiny';
type Appearance = { variant?: Variant; size?: Size; className?: string };

function buttonClasses({ variant = 'primary', size = 'default', className = '' }: Appearance) {
  return ['btn', variant !== 'primary' && variant, size !== 'default' && size, className].filter(Boolean).join(' ');
}

/** An action using the app's shared button sizes and states. */
export function Button({ variant, size, className, ...props }: Appearance & ComponentPropsWithoutRef<'button'>) {
  return <button className={buttonClasses({ variant, size, className })} {...props} />;
}

/** An icon-only action. Callers supply an accessible name. */
export function IconButton({ className = '', ...props }: ComponentPropsWithoutRef<'button'>) {
  return <button className={`icon-btn ${className}`.trim()} {...props} />;
}

/** A navigation link with the same appearance as a button. */
export function ButtonLink({ variant, size, className, ...props }: Appearance & ComponentPropsWithoutRef<'a'>) {
  return <a className={buttonClasses({ variant, size, className })} {...props} />;
}

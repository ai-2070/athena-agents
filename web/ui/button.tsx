import type { ComponentPropsWithoutRef } from 'react';
import { buttonClass, iconButtonClass } from './classes.ts';
import type { ButtonSize, ButtonVariant, IconButtonVariant } from './classes.ts';

export { buttonClass, iconButtonClass } from './classes.ts';
export type { ButtonSize, ButtonVariant, IconButtonVariant } from './classes.ts';

interface Appearance {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** An action in the app's shared style. */
export function Button({ variant, size, className, ...props }: Appearance & ComponentPropsWithoutRef<'button'>) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

/** A navigation link that looks like a button. */
export function ButtonLink({ variant, size, className, ...props }: Appearance & ComponentPropsWithoutRef<'a'>) {
  return <a className={buttonClass(variant, size, className)} {...props} />;
}

/** An icon-only action. Callers supply an accessible name. */
export function IconButton({ variant, className = '', ...props }: { variant?: IconButtonVariant } & ComponentPropsWithoutRef<'button'>) {
  return <button className={iconButtonClass(variant, className)} {...props} />;
}

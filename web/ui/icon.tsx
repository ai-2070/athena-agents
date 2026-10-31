// The app's line icons in React: one of the names in web/phosphor.ts, at the page's weight.
// Its own module, so a dialog can draw an icon without reaching through web/ui/react.tsx (which imports the
// app core, and the core opens dialogs).
import { createContext, useContext } from 'react';
import { phosphorFor } from '../phosphor.ts';

export type IconWeight = 'light' | 'regular';
const IconWeightContext = createContext<IconWeight>('light');
/** Icons inside it are drawn at this weight (Light unless a part of the page asks for a step stronger). */
export const IconWeightProvider = IconWeightContext.Provider;
export const useIconWeight = (): IconWeight => useContext(IconWeightContext);

/** One of the app's line icons (Phosphor, picked by name in web/phosphor.ts). */
export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  const Glyph = phosphorFor(name);
  return <Glyph weight={useIconWeight()} size={size} className={`ico-svg ${className}`.trim()} aria-hidden="true" />;
}

// "Rich answers": an answer written in OpenUI Lang (an agent with Rich answers on) rendered as live
// components (cards, tables, charts, forms) with OpenUI's chat component library. Loaded only when an
// answer needs it: the library (charts, forms…) is big.
import { useCallback } from 'react';
import { BuiltinActionType, Renderer } from '@openuidev/react-lang';
import type { ActionEvent } from '@openuidev/react-lang';
// (from the package root, not its subpaths: the component library and the theme must be the same copy,
// or the components never see the theme — genui-lib and ThemeProvider/ each bundle their own)
import { ThemeProvider, createTheme, openuiChatLibrary } from '@openuidev/react-ui';

// OpenUI's stylesheet (copied next to the bundle by scripts/build-web.ts), linked once.
function linkStyles(): void {
  if (document.querySelector('link[data-openui]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/dist/openui.css';
  link.dataset.openui = '';
  document.head.append(link);
}

// The dashboard's look, as OpenUI theme tokens (its colors come from the page's own variables).
const dark = createTheme({
  background: 'var(--bg)',
  foreground: 'var(--panel)',
  popoverBackground: 'var(--panel-2)',
  textNeutralPrimary: 'var(--ink)',
  textNeutralSecondary: 'var(--dim)',
  textNeutralTertiary: 'var(--faint)',
  textAccentPrimary: 'var(--accent)',
  textNeutralLink: 'var(--accent)',
  interactiveAccentDefault: 'var(--accent)',
  interactiveAccentHover: 'var(--accent-hover)',
  interactiveAccentPressed: 'var(--accent-dim)',
  borderDefault: 'var(--line)',
  borderInteractive: 'var(--line-2)',
  borderAccent: 'var(--accent)',
  fontBody: 'inherit',
  fontHeading: 'inherit',
  fontLabel: 'inherit',
  fontCode: 'var(--mono)',
});

/** What an action on a rich answer sends back to the agent (as your next message). */
export function actionMessage(event: ActionEvent): string | null {
  if (event.type !== BuiltinActionType.ContinueConversation) return null;
  const form = event.formState && Object.keys(event.formState).length ? `\n\n(form: ${JSON.stringify(event.formState)})` : '';
  return `${event.humanFriendlyMessage || 'Continue'}${form}`;
}

export default function RichAnswer({ code, streaming, onSend }: { code: string; streaming: boolean; onSend: (text: string) => void }) {
  linkStyles();
  const onAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.OpenUrl) {
        const url = event.params?.url;
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
        return;
      }
      const text = actionMessage(event);
      if (text) onSend(text);
    },
    [onSend],
  );
  return (
    <ThemeProvider mode="dark" darkTheme={dark} cssSelector=".oc-rich">
      <div className="oc-rich">
        <Renderer response={code} library={openuiChatLibrary} isStreaming={streaming} onAction={onAction} />
      </div>
    </ThemeProvider>
  );
}

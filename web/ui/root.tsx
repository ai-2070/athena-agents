// Every React root in the page starts here, so a piece that crashes while drawing shows a short message in its
// own place instead of going blank (with the rest of the page still working). In `bun run dev` this is also what
// lets hot reload draw the piece again once the code is fixed: React only retries a crash an error boundary caught.
// A leaf module (React only), so anything may import it without a cycle.
import { Component, Fragment, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root, RootOptions } from 'react-dom/client';
import { Button } from './button.tsx';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface GuardState {
  error: { value: unknown } | null;
  /** Bumped by Try again: the piece is drawn afresh, not from the state it crashed in. */
  attempt: number;
}

interface GuardProps {
  children?: ReactNode;
  /** Drawn inside a control (a button): a short note with the details on hover, and no buttons of its own (a
   *  button can't hold another, and a click would also reach the control). Drawing it again tries again. */
  inline?: boolean;
}

/** Catches a crash while drawing its children and offers to try again. New children (the caller drew the root
 *  again with other content) clear the crash by themselves. */
export class CrashGuard extends Component<GuardProps, GuardState> {
  override state: GuardState = { error: null, attempt: 0 };

  static getDerivedStateFromError(value: unknown): Partial<GuardState> {
    return { error: { value } };
  }

  override componentDidUpdate(prev: GuardProps): void {
    if (this.state.error && prev.children !== this.props.children) this.retry();
  }

  retry = (): void => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    if (this.props.inline)
      return (
        <span role="alert" className="crash-guard text-red" title={messageOf(error.value)}>
          Something went wrong
        </span>
      );
    return (
      <div
        role="alert"
        className="crash-guard flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-panel px-3 py-2 text-[13px] text-dim"
      >
        <span className="min-w-0 flex-1 wrap-anywhere">
          <span className="text-red">Something went wrong here.</span> {messageOf(error.value)}
        </span>
        <Button variant="ghost" size="small" onClick={this.retry}>
          Try again
        </Button>
        <Button variant="plain" size="small" onClick={() => location.reload()}>
          Reload page
        </Button>
      </div>
    );
  }
}

/** createRoot from react-dom, with every render() wrapped in a CrashGuard. Use it for every React root.
 *  strict: the whole root in StrictMode (outside the guard, so the root itself is strict, as before the guard).
 *  inline: the root is inside a control (CrashGuard's inline). */
export function createAppRoot(
  el: Element | DocumentFragment,
  { strict = false, inline = false, ...options }: RootOptions & { strict?: boolean; inline?: boolean } = {},
): Root {
  const root = createRoot(el, options);
  const guard = (node: ReactNode) => <CrashGuard inline={inline}>{node}</CrashGuard>;
  return {
    render: (node: ReactNode) => root.render(strict ? <StrictMode>{guard(node)}</StrictMode> : guard(node)),
    unmount: () => root.unmount(),
  };
}

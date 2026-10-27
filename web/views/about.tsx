// Settings > About: which Blacksite this is, where it lives on GitHub (with a star button), and this PC's
// address and data folder.
import { useEffect, useState } from 'react';
import { GET } from '../core.ts';
import { logo } from '../icons.ts';
import { DomNode, Icon, useAppState } from '../ui/react.tsx';
import { REPO, repoLink } from '../../shared/about.ts';
import type { AboutInfo } from '../../shared/types.ts';

/** The Blacksite mark (public/icon.svg): a lime wedge. */
export const BrandMark = ({ size = 48 }: { size?: number }) => (
  <svg className="about-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <path d="M14 50 L50 14 L50 50 Z" fill="currentColor" />
  </svg>
);

/** "Star on GitHub", with the count when GitHub gave one. */
export function StarButton({ stars, small = false }: { stars: number | null; small?: boolean }) {
  return (
    <a className={`btn${small ? ' tiny' : ' small'} star-btn`} href={REPO.url} target="_blank" rel="noopener" title={`Star ${REPO.slug} on GitHub`}>
      <Icon name="star" size={small ? 12 : 14} />
      <span>{small ? 'Star' : 'Star on GitHub'}</span>
      {stars != null ? <span className="star-count">{stars.toLocaleString()}</span> : null}
    </a>
  );
}

export function AboutTab() {
  const data = useAppState();
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    let live = true;
    GET<AboutInfo>('/about?stars=1').then(
      (a) => live && setAbout(a),
      () => {},
    );
    return () => void (live = false);
  }, []);
  const version = about ? `v${about.version}` : '…';
  return (
    <div className="two-col">
      <div className="col gap-lg">
        <div className="panel about-panel">
          <div className="about-head">
            <BrandMark size={52} />
            <div className="about-title">
              <h2>{REPO.name}</h2>
              <span className="ai-version">{version}</span>
            </div>
          </div>
          <p className="about-lede">Run AI agents and teams from one local workspace. A live 3D map, team chats, Claude Code, Codex and local models, MCP tools, an approval Outbox and Artifacts. No account, runs on your computer.</p>
          <div className="about-actions">
            <StarButton stars={about?.stars ?? null} />
            <a className="btn ghost small about-repo" href={REPO.url} target="_blank" rel="noopener">
              <DomNode as="span" className="about-gh" make={() => logo('github', 14, '#e6e8e0')} deps={[]} />
              <span>{REPO.slug}</span>
            </a>
          </div>
          <div className="kv mt-lg">
            <span>Version</span>
            <span className="mono">{version}</span>
            <span>GitHub</span>
            <span>
              <a className="mono wrap-anywhere" href={REPO.url} target="_blank" rel="noopener">
                {REPO.url.replace(/^https:\/\//, '')}
              </a>
            </span>
            <span>Licence</span>
            <span>{about?.license ? about.license.replace(/ OR /g, ' or ') : '…'}</span>
            <span>Help</span>
            <span>
              <a href={repoLink('issues')} target="_blank" rel="noopener">Report a problem</a> · <a href={repoLink('releases')} target="_blank" rel="noopener">What's new</a>
            </span>
          </div>
        </div>
      </div>
      <div className="col gap-lg">
        {data ? (
          <div className="panel">
            <div className="panel-head">
              <h2>This PC</h2>
            </div>
            <div className="kv">
              <span>Address</span>
              <span className="mono">{`http://localhost:${data.port}`}</span>
              <span>Login</span>
              <span>None. Only this PC can open it (it listens on 127.0.0.1).</span>
              <span>Data</span>
              <span className="mono wrap-anywhere">{data.dataDir}</span>
            </div>
            <p className="hint mt">Keys and account tokens are stored in that data folder on this PC and never sent to the browser.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

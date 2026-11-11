// Settings > About: which Athena Agents this is, where it lives on GitHub (with a star button), and this PC's
// address and data folder.
import { ButtonLink } from '../ui/button.tsx';
import { Plate } from '../ui/surface.tsx';
import { useEffect, useState } from 'react';
import { rpc } from '../client/rpc.ts';
import { BRAND_IMAGE } from '../brand.ts';
import { serverUrl } from '../client/connection.ts';
import { logo } from '../icons.ts';
import { Row, Section } from '../ui/controls.tsx';
import { DomNode, Icon, useAppState } from '../ui/react.tsx';
import { REPO, repoLink } from '../../shared/about.ts';
import type { AboutInfo } from '../../shared/types.ts';
import { AI_VERSION } from './settings.tsx';

/** The supplied Athena helmet, shared with the sidebar and desktop app. */
export const BrandMark = ({ size = 48 }: { size?: number }) => (
  <img
    className="brand-mark flex-none"
    src={serverUrl(BRAND_IMAGE)}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
  />
);

/** "Star on GitHub", with the count when GitHub gave one. */
export function StarButton({ stars, small = false }: { stars: number | null; small?: boolean }) {
  return (
    <ButtonLink
      size={small ? 'tiny' : 'small'}
      className="star-btn gap-1.75"
      href={REPO.url}
      target="_blank"
      rel="noopener"
      title={`Star ${REPO.slug} on GitHub`}
    >
      <Icon name="star" size={small ? 12 : 14} />
      <span>{small ? 'Star' : 'Star on GitHub'}</span>
      {stars != null ? (
        <span className="ml-0.5 border-l border-[color-mix(in_srgb,currentColor_35%,transparent)] pl-2 tabular-nums">
          {stars.toLocaleString()}
        </span>
      ) : null}
    </ButtonLink>
  );
}

// a value on the right of a row: it may be long (a folder), so it wraps and reads from the right
const VALUE = 'max-w-[30rem] text-[13.5px] text-ink wrap-anywhere';
const RIGHT = `${VALUE} text-right max-sm:text-left`;

export function AboutTab() {
  const data = useAppState();
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    let live = true;
    rpc.status.about({ stars: '1' }).then(
      (a) => live && setAbout(a),
      () => {},
    );
    return () => void (live = false);
  }, []);
  const version = about ? `v${about.version}` : '…';
  return (
    <div className="flex flex-col gap-10">
      <Plate className="flex flex-wrap items-center gap-x-6 gap-y-5 rounded-box p-7">
        <BrandMark size={112} />
        <div className="min-w-0 flex-1 basis-80">
          <div className="about-title flex flex-wrap items-baseline gap-2.5">
            <h2 className="m-0 font-brand text-[24px] leading-[1.15] font-semibold tracking-tight">{REPO.name}</h2>
            <span className={`${AI_VERSION} text-[13px]`}>{version}</span>
          </div>
          <p className="mt-2 mb-0 max-w-[62ch] text-[14px] leading-[1.6] text-dim">
            Run AI agents and teams from one local workspace. A live 3D map, team chats, Claude Code, Codex and local
            models, MCP tools, an approval Outbox and Artifacts. No account, runs on your computer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StarButton stars={about?.stars ?? null} />
          <ButtonLink variant="ghost" size="small" className="gap-1.75" href={REPO.url} target="_blank" rel="noopener">
            <DomNode as="span" className="inline-flex" make={() => logo('github', 14, 'currentColor')} deps={[]} />
            <span>{REPO.slug}</span>
          </ButtonLink>
        </div>
      </Plate>

      <Section title="Version" description="What is installed, where it lives, and where to get help.">
        <Row title="Version">
          <span className="font-mono text-[13px] text-ink">{version}</span>
        </Row>
        <Row title="GitHub">
          <span className={RIGHT}>
            <a className="font-mono text-[13px]" href={REPO.url} target="_blank" rel="noopener">
              {REPO.url.replace(/^https:\/\//, '')}
            </a>
          </span>
        </Row>
        <Row title="Licence">
          <span className={RIGHT}>{about?.license ? about.license.replace(/ OR /g, ' or ') : '…'}</span>
        </Row>
        <Row title="Help">
          <span className={RIGHT}>
            <a href={repoLink('issues')} target="_blank" rel="noopener">
              Report a problem
            </a>{' '}
            ·{' '}
            <a href={repoLink('releases')} target="_blank" rel="noopener">
              What's new
            </a>
          </span>
        </Row>
      </Section>

      {data ? (
        <Section title="This PC" description="Where the dashboard runs and keeps what you set up.">
          <Row title="Address">
            <span className={`${RIGHT} font-mono text-[13px]`}>{`http://localhost:${data.port}`}</span>
          </Row>
          <Row title="Login">
            <span className={RIGHT}>None. Only this PC can open it (it listens on 127.0.0.1).</span>
          </Row>
          <Row title="Data">
            <span className={`${VALUE} font-mono text-[13px]`}>{data.dataDir}</span>
          </Row>
        </Section>
      ) : null}
    </div>
  );
}

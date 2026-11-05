// What each skill that comes with the dashboard is drawn with: the app's icon (the Craft apps, Orca, Cua,
// Composio), the logo of what it works with (GitHub, Docker, Jira…), or a line icon for the kind of work.
// Keyed by the skill's id. web/skillicons.ts draws them; tests/server/skillmarks.test.ts checks every
// bundled skill has one. The Craft apps' own skills aren't listed: web/crafticons.ts finds their icons.

/** img: a picture (tile: the dark square a light mark sits on). logo: a brand logo in web/icons.ts. icon: a Phosphor line icon, in a colour of its own or the accent. */
export type SkillMarkSpec = { img: string; tile?: string; craft?: boolean } | { logo: string } | { icon: string; color?: string };

const ORCA = { img: '/app-icons/orca.png' };
const CUA = { img: '/app-icons/cua.png' };
const OOMOL = { logo: 'oomol' };

export const SKILL_MARKS: Record<string, SkillMarkSpec> = {
  // the dashboard's own (server/skills.ts BUILTIN)
  'self-improvement': { icon: 'sparkles' },
  'voxel-building': { icon: 'box' },
  'orca-agents': ORCA,
  // skills/athena
  'action-items': { icon: 'list-checks' },
  arxiv: { logo: 'arxiv' },
  'ast-grep': { icon: 'list-magnifying-glass' },
  comfyui: { img: '/app-icons/comfyui.png', tile: '#17181c' },
  decisions: { icon: 'scales' },
  'docker-management': { logo: 'docker' },
  docx: { icon: 'microsoft-word', color: '#2b579a' },
  dogfood: { icon: 'browser' },
  email: { icon: 'mail' },
  fastmcp: { logo: 'model context protocol' },
  'financial-models': { icon: 'calculator' },
  github: { logo: 'github' },
  'grill-me': { icon: 'fire' },
  'grounded-citations': { icon: 'quotes' },
  humanizer: { icon: 'feather' },
  'jupyter-notebook': { logo: 'jupyter' },
  learn: { icon: 'graduation-cap' },
  'llm-wiki': { icon: 'book-open' },
  maps: { logo: 'openstreetmap' },
  pdf: { icon: 'file-pdf', color: '#d93831' },
  powerpoint: { icon: 'microsoft-powerpoint', color: '#c43e1c' },
  'requesting-code-review': { icon: 'git-diff' },
  'rest-graphql-debug': { icon: 'brackets-curly' },
  'rss-feeds': { logo: 'rss' },
  spike: { icon: 'lightbulb' },
  stocks: { icon: 'chart-line-up' },
  'systematic-debugging': { icon: 'bug' },
  'test-driven-development': { icon: 'test-tube' },
  'weekly-review-planning': { icon: 'calendar-check' },
  xlsx: { icon: 'microsoft-excel', color: '#217346' },
  'youtube-content': { logo: 'youtube' },
  // skills/composio, skills/cua, skills/oomol
  composio: { img: '/app-icons/composio.png' },
  'cua-sandboxes': CUA,
  'gui-automation': CUA,
  'cua-driver': CUA,
  oo: OOMOL,
  'oo-create-skill': OOMOL,
  'oo-find-skills': OOMOL,
  'oo-publish-skill': OOMOL,
  // skills/orca: Orca's own, or what the skill works with
  'orca-cli': ORCA,
  orchestration: ORCA,
  'computer-use': ORCA,
  'orca-per-workspace-env': ORCA,
  'orca-emulator': { logo: 'apple' },
  'orca-emulator-android': { logo: 'android' },
  'orca-jira': { logo: 'jira' },
  'jira-tickets': { logo: 'jira' },
  'orca-linear': { logo: 'linear' },
  // skills/storytold (the Craft apps themselves get their icons from crafticons.ts)
  storytold: { icon: 'shapes' },
  'storytold-install': { icon: 'download' },
  // skills/subagent-skills
  'commissioning-a-reviewer': { icon: 'seal-check' },
  'delegating-to-subagents': { icon: 'arrows-split' },
  'independent-review': { icon: 'binoculars' },
  'reviewed-stage-delivery': { icon: 'stairs' },
  'witness-discipline': { icon: 'microscope' },
};

// The app's name, and where it lives on GitHub. The sidebar, Settings > About and the server use these.
export const REPO = {
  name: 'Athena Agents',
  slug: 'ai-2070/athena-agents',
  url: 'https://github.com/ai-2070/athena-agents',
} as const;

export const repoLink = (sub: '' | 'issues' | 'releases' = ''): string => (sub ? `${REPO.url}/${sub}` : REPO.url);

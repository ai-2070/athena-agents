import { expect, it } from 'vitest';
import { presetIcon } from '../../web/preseticons.ts';
import { icon } from '../../web/icons.ts';

it('gives every bundled MCP preset a brand or a descriptive icon', () => {
  const names = ['playwright', 'chrome-devtools', 'filesystem', 'fetch', 'memory', 'sequential-thinking', 'blender', 'hermes', 'github', 'context7', 'brave-search', 'firecrawl', 'deepwiki', 'microsoft-learn', 'aws-knowledge', 'twilio-docs', 'wolfram', 'kiwi', 'trivago', 'notion', 'linear', 'atlassian', 'clickup', 'monday', 'todoist', 'airtable', 'craft', 'miro', 'dropbox', 'calendly', 'fireflies', 'gamma', 'intercom', 'strava', 'oomol', 'composio', 'gitlab', 'sentry', 'vercel', 'netlify', 'cloudflare', 'railway', 'supabase', 'neon', 'prisma-postgres', 'motherduck', 'circleci', 'buildkite', 'postman', 'semgrep', 'datadog', 'grafana', 'betterstack', 'globalping', 'huggingface', 'comfy-cloud', 'cloudinary', 'webflow', 'wordpress-com', 'amplitude', 'mixpanel', 'algolia', 'twelve-data', 'attio', 'close', 'klaviyo', 'unity', 'unreal', 'godot', 'elevenlabs', 'maya', 'houdini', 'substance-painter', 'tripo', 'meshy', 'sketchfab', 'freecad', 'rhino', 'openscad', '3d-printer', 'unsplash', 'pixabay', 'pexels', 'canva', 'freepik', 'google-design', 'gimp', 'krita', 'inkscape', 'audacity', 'reaper', 'musescore', 'obs', 'topaz'];
  const box = icon('box').querySelector('path')!.getAttribute('d');
  for (const name of names) {
    const mark = presetIcon(name);
    expect(mark.getAttribute('width')).toBe('17');
    if (mark.tagName.toLowerCase() === 'svg') expect(mark.querySelector('path')!.getAttribute('d')).not.toBe(box);
    else expect(mark.getAttribute('src')).toMatch(/\.(svg|png)$/);
  }
});

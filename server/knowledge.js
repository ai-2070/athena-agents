// Each agent's knowledge: files you add (data/knowledge/<agent>/) plus folders you link.
// Small knowledge goes straight into the agent's instructions; big knowledge is searched on demand.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, walk, exists } from './util.js';
import { projectData } from './store.js';

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|tsv|html?|xml|js|mjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|cs|css|scss|sql|sh|ps1|toml|ini|cfg|log|srt|vtt|rtf)$/i;
const INLINE_LIMIT = 24_000;

export const knowledgeDir = (agentId) => ensureDir(projectData('knowledge', agentId));

export function knowledgeFiles(agent) {
  const files = [];
  const own = knowledgeDir(agent.id);
  for (const f of walk(own, { maxDepth: 4, filter: (p) => TEXT_EXT.test(p) })) files.push({ path: f, label: path.relative(own, f), own: true });
  for (const folder of agent.knowledge?.folders || []) {
    if (!exists(folder)) continue;
    const st = fs.statSync(folder);
    if (st.isFile()) files.push({ path: folder, label: path.basename(folder), own: false });
    else for (const f of walk(folder, { maxDepth: 5, filter: (p) => TEXT_EXT.test(p), limit: 2000 })) files.push({ path: f, label: path.join(path.basename(folder), path.relative(folder, f)), own: false });
  }
  return files.map((f) => {
    let size = 0;
    try {
      size = fs.statSync(f.path).size;
    } catch {
      /* gone */
    }
    return { ...f, size };
  });
}

export function addKnowledgeFile(agentId, name, content) {
  const safe = path.basename(String(name || 'note.md')).replace(/[^\w.\- ]+/g, '_');
  const file = path.join(knowledgeDir(agentId), TEXT_EXT.test(safe) ? safe : `${safe}.md`);
  fs.writeFileSync(file, content);
  return file;
}

export function removeKnowledgeFile(agentId, label) {
  const own = knowledgeDir(agentId);
  const file = path.resolve(own, label);
  if (!file.startsWith(own)) throw new Error('Not an agent knowledge file.');
  fs.unlinkSync(file);
}

const read = (p, max = 200_000) => {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

// The text placed in the agent's instructions.
export function knowledgeContext(agent) {
  const files = knowledgeFiles(agent);
  if (!files.length) return '';
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total <= INLINE_LIMIT) {
    return (
      '\n\n# Your knowledge\nThese files are your reference material. Rely on them and cite the file name when you use them.\n' +
      files.map((f) => `\n## ${f.label}\n${read(f.path)}`).join('\n')
    );
  }
  const list = files
    .slice(0, 200)
    .map((f) => `- ${f.label} (${Math.round(f.size / 1024)} KB)`)
    .join('\n');
  return `\n\n# Your knowledge\nYou have ${files.length} reference files (${Math.round(total / 1024)} KB). Search them with knowledge_search before answering anything they might cover, and open one with knowledge_read.\n${list}${files.length > 200 ? `\n…and ${files.length - 200} more` : ''}`;
}

export function searchKnowledge(agent, query, limit = 6) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits = [];
  for (const f of knowledgeFiles(agent)) {
    const text = read(f.path, 2_000_000);
    const lines = text.split(/\r?\n/);
    const size = 40;
    for (let i = 0; i < lines.length; i += size / 2) {
      const chunk = lines.slice(i, i + size).join('\n');
      const low = chunk.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = low.indexOf(t);
        let n = 0;
        while (idx !== -1 && n < 20) {
          n++;
          idx = low.indexOf(t, idx + t.length);
        }
        if (n) score += 1 + Math.log(n);
      }
      if (score > 0) hits.push({ file: f.label, line: i + 1, score: score + (low.includes(String(query).toLowerCase()) ? 3 : 0), text: chunk.slice(0, 1600) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function readKnowledge(agent, label, offsetLine = 1, lines = 400) {
  const f = knowledgeFiles(agent).find((x) => x.label === label) || knowledgeFiles(agent).find((x) => x.label.toLowerCase().includes(String(label).toLowerCase()));
  if (!f) throw new Error(`No knowledge file "${label}".`);
  const all = read(f.path, 5_000_000).split(/\r?\n/);
  const start = Math.max(0, (offsetLine || 1) - 1);
  return { file: f.label, from: start + 1, to: Math.min(all.length, start + lines), total: all.length, text: all.slice(start, start + lines).join('\n') };
}

export function knowledgeRoots(agent) {
  return [knowledgeDir(agent.id), ...(agent.knowledge?.folders || []).filter(exists)];
}

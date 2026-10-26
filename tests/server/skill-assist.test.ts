import { describe, expect, it } from 'vitest';
import { draftSkill } from '../../server/brain.ts';

// The model's part is played by a function that records what it was asked and answers with set text.
function model(answer: unknown) {
  const calls: { system: string; user: string }[] = [];
  const ask = async (system: string, user: string) => {
    calls.push({ system, user });
    return typeof answer === 'string' ? answer : `Here it is:\n${JSON.stringify(answer)}`;
  };
  return { ask, calls };
}

const current = { name: 'Release notes', description: 'Use when writing release notes.', body: '# Steps\n\n1. List user-facing changes first.\n2. Link the PR.' };

describe('skills from plain words', () => {
  it('writes a new skill from a description', async () => {
    const m = model({ name: 'Email to clients', description: 'Use when writing an email to a client.', body: '# How\n\nBe brief.', note: 'Wrote a short email skill.' });
    const d = await draftSkill('How I write emails to clients: brief, warm, one ask', { ask: m.ask, others: [{ slug: 'brand-voice', name: 'Brand voice', description: 'Our tone everywhere' }] });
    expect(d).toEqual({ name: 'Email to clients', description: 'Use when writing an email to a client.', body: '# How\n\nBe brief.', note: 'Wrote a short email skill.' });
    expect(m.calls[0].system).toMatch(/Write a new skill/);
    expect(m.calls[0].system).toContain('Brand voice: Our tone everywhere'); // so it doesn't write a copy
    expect(m.calls[0].system).toMatch(/Never put secrets/);
    expect(m.calls[0].user).toContain('brief, warm, one ask');
    expect(m.calls[0].user).not.toContain('CURRENT skill');
  });

  it('changes a skill: the model sees all of it, with its files, and what to change', async () => {
    const m = model({ ...current, body: `${current.body}\n3. Add a thumbnail.`, note: 'Added a thumbnail step.' });
    const d = await draftSkill('add a step about thumbnails', { current, files: ['template.md'], ask: m.ask });
    expect(d.body).toContain('3. Add a thumbnail.');
    expect(m.calls[0].system).toMatch(/Keep everything they did not ask to change/);
    expect(m.calls[0].user).toContain('CURRENT skill:\nname: Release notes');
    expect(m.calls[0].user).toContain('1. List user-facing changes first.');
    expect(m.calls[0].user).toContain('extra files with it: template.md');
    expect(m.calls[0].user).toContain('What to change:\nadd a step about thumbnails');
  });

  it('keeps a field the model left out or emptied while editing', async () => {
    const d = await draftSkill('shorter description', { current, ask: model({ description: 'Release notes.', body: '   ', note: 'Shortened it.' }).ask });
    expect(d).toMatchObject({ name: 'Release notes', description: 'Release notes.', body: current.body });
  });

  it('turns away an answer that is not a skill', async () => {
    await expect(draftSkill('x', { ask: model('Sorry, I cannot help with that.').ask })).rejects.toThrow(/wasn't a skill/);
    await expect(draftSkill('x', { ask: model('{"name": "broken", ').ask })).rejects.toThrow(/wasn't a skill/);
    // a new skill needs all three
    await expect(draftSkill('x', { ask: model({ name: 'Only a name' }).ask })).rejects.toThrow(/missing/);
  });

  it('keeps every field to its size, on one line where it must be', async () => {
    const d = await draftSkill('big', { ask: model({ name: 'N'.repeat(200), description: 'Use\nwhen\n\nwriting.', body: 'b'.repeat(70000) }).ask });
    expect(d.name).toHaveLength(80);
    expect(d.description).toBe('Use when writing.');
    expect(d.body).toHaveLength(60000);
  });

  it('works from attached files alone', async () => {
    const m = model({ ...current, note: '' });
    await draftSkill('', { ask: m.ask });
    expect(m.calls[0].user).toMatch(/Write a skill from the attached files/);
    await draftSkill('', { current, ask: m.ask });
    expect(m.calls[1].user).toMatch(/Improve it using the attached files/);
  });
});

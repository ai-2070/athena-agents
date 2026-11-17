// What a scene may say to the Station (shared/scene.ts): a scene is agent-written code, so the page reads only
// messages that fit these schemas, and paths and file types are checked the same way on both sides.
import { describe, expect, it } from 'vitest';
import { readSceneMessage, scenePath, sceneType } from '../../shared/scene.ts';

describe('messages from a scene', () => {
  it('reads the ones the protocol has', () => {
    expect(readSceneMessage({ athena: 1, type: 'ready' })).toEqual({ athena: 1, type: 'ready' });
    expect(readSceneMessage({ athena: 1, type: 'pick', kind: 'agent', id: 'a1' })).toMatchObject({ kind: 'agent' });
    expect(readSceneMessage({ athena: 1, type: 'menu', kind: 'team', id: 't', x: 4, y: 5 })).not.toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'hover', pick: null })).not.toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'fps', fps: 58 })).not.toBeNull();
    expect(
      readSceneMessage({ athena: 1, type: 'capture', request: 'r1', image: 'data:image/png;base64,AAAA' }),
    ).not.toBeNull();
  });

  it('drops anything else', () => {
    expect(readSceneMessage(null)).toBeNull();
    expect(readSceneMessage('ready')).toBeNull();
    expect(readSceneMessage({ type: 'ready' })).toBeNull();
    expect(readSceneMessage({ athena: 2, type: 'ready' })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'navigate', url: 'https://example.com' })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'pick', kind: 'settings' })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'pick', kind: 'agent', id: 'x'.repeat(500) })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'menu', kind: 'agent', id: 'a', x: Number.NaN, y: 0 })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'capture', request: 'r', image: 'javascript:alert(1)' })).toBeNull();
    expect(readSceneMessage({ athena: 1, type: 'fps', fps: -1 })).toBeNull();
  });

  it('caps what a log line says', () => {
    const m = readSceneMessage({ athena: 1, type: 'log', level: 'error', text: 'e'.repeat(5000), uncaught: true });
    expect(m?.type === 'log' && m.text.length).toBe(2000);
  });
});

describe('scene paths and file types', () => {
  it('keeps paths inside the scene folder', () => {
    expect(scenePath('index.html')).toBe('index.html');
    expect(scenePath('js\\fish.js')).toBe('js/fish.js');
    for (const bad of ['', '../x', 'a/../b', '/etc/passwd', 'a//b', '.env', 'a/.git/config', 'c:x', 'a\0b'])
      expect(scenePath(bad)).toBeNull();
  });
  it('knows the types a scene may hold', () => {
    expect(sceneType('index.html')).toMatch(/text\/html/);
    expect(sceneType('models/boat.GLB')).toBe('model/gltf-binary');
    expect(sceneType('run.py')).toBeNull();
    expect(sceneType('Makefile')).toBeNull();
    expect(sceneType('dir.js/readme')).toBeNull();
  });
});

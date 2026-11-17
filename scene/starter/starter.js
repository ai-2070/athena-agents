// The starter scene: the Station drawn simply, as a pattern for builders to start from (copy this folder into
// .dashboard/scene/ and change it). The Brain is an orb in the middle, each team a ring around it, each agent a
// figure on its team's ring (agents in no team stand near the Brain). Green: working; amber: needs you.
//
// Everything is drawn from Athena's state; ids stay the same between states, so things are kept and only
// changed (a scene that rebuilt everything on each state would flicker).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Athena } from '/scene-lib/athena-scene.js';

const WORKING = new THREE.Color('#2fa84f');
const NEEDS = new THREE.Color('#e0a020');

// ---------- renderer, camera, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 46, 34);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.45;
controls.minDistance = 12;
controls.maxDistance = 140;
const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.4);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(20, 40, 10);
scene.add(hemi, sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 96), new THREE.MeshStandardMaterial({ roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// ---------- the Brain ----------
const brain = new THREE.Group();
const core = new THREE.Mesh(
  new THREE.SphereGeometry(2.2, 48, 32),
  new THREE.MeshStandardMaterial({ emissiveIntensity: 0.8, roughness: 0.3 }),
);
const shell = new THREE.Mesh(
  new THREE.IcosahedronGeometry(3.4, 1),
  new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.35 }),
);
brain.add(core, shell);
brain.position.y = 4;
core.userData.pick = { kind: 'brain' };
scene.add(brain);

// ---------- teams and agents, kept by id ----------
const teams = new Map(); // id -> { group, ring, label }
const agents = new Map(); // key (team:agent) -> { group, body, light, label, agentId }
const labels = document.getElementById('labels');
const pickables = [core];

function label(cls) {
  const el = document.createElement('div');
  el.className = `label ${cls}`;
  labels.append(el);
  return el;
}

function teamThing(t) {
  let x = teams.get(t.id);
  if (!x) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4, 0.18, 12, 64),
      new THREE.MeshStandardMaterial({ roughness: 0.5 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.userData.pick = { kind: 'team', id: t.id };
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(4, 48),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.12 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.02;
    pad.userData.pick = { kind: 'team', id: t.id };
    group.add(ring, pad);
    scene.add(group);
    pickables.push(ring, pad);
    x = { group, ring, pad, label: label('team') };
    teams.set(t.id, x);
  }
  x.ring.material.color.set(t.color);
  x.pad.material.color.set(t.color);
  x.label.textContent = `${t.emoji ? `${t.emoji} ` : ''}${t.name}`;
  return x;
}

function agentThing(key, a) {
  let x = agents.get(key);
  if (!x) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 0.9, 6, 16),
      new THREE.MeshStandardMaterial({ roughness: 0.6 }),
    );
    body.position.y = 0.95;
    body.userData.pick = { kind: 'agent', id: a.id };
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshBasicMaterial({ transparent: true }),
    );
    light.position.y = 2.25;
    group.add(body, light);
    scene.add(group);
    pickables.push(body);
    x = { group, body, light, label: label('agent'), agentId: a.id };
    agents.set(key, x);
  }
  x.body.material.color.set(a.color);
  x.light.material.color.copy(a.status === 'needs' ? NEEDS : a.status === 'working' ? WORKING : idleColor);
  x.light.material.opacity = a.status === 'idle' ? 0.35 : 1;
  x.status = a.status;
  x.label.innerHTML = '';
  x.label.append(`${a.emoji} ${a.name}`);
  if (a.now) {
    const s = document.createElement('small');
    s.textContent = a.now;
    x.label.append(s);
  }
  return x;
}

function drop(map, keep) {
  for (const [k, x] of map) {
    if (keep.has(k)) continue;
    scene.remove(x.group);
    x.label.remove();
    for (const o of [x.ring, x.pad, x.body]) {
      const i = pickables.indexOf(o);
      if (i >= 0) pickables.splice(i, 1);
    }
    map.delete(k);
  }
}

let state = null;
function draw(s) {
  state = s;
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const keepTeams = new Set();
  const keepAgents = new Set();
  const n = Math.max(s.teams.length, 1);
  const radius = 10 + n * 2.2;
  s.teams.forEach((t, i) => {
    const x = teamThing(t);
    keepTeams.add(t.id);
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    x.group.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    t.members.forEach((id, j) => {
      const a = byId.get(id);
      if (!a) return;
      const key = `${t.id}:${id}`;
      const y = agentThing(key, a);
      keepAgents.add(key);
      const m = (j / t.members.length) * Math.PI * 2;
      y.group.position.set(x.group.position.x + Math.cos(m) * 2.6, 0, x.group.position.z + Math.sin(m) * 2.6);
    });
  });
  // agents in no team stand around the Brain
  const loose = s.agents.filter((a) => !a.teams.length);
  loose.forEach((a, j) => {
    const key = `-:${a.id}`;
    const y = agentThing(key, a);
    keepAgents.add(key);
    const m = (j / loose.length) * Math.PI * 2;
    y.group.position.set(Math.cos(m) * 7, 0, Math.sin(m) * 7);
  });
  drop(teams, keepTeams);
  drop(agents, keepAgents);
}

// ---------- light and dark ----------
let reduced = false;
let idleColor = new THREE.Color('#9a9aa0');
function theme(t) {
  const dark = t.theme === 'dark';
  reduced = t.reducedMotion;
  const bg = dark ? '#0f1114' : '#f6f6f4';
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 60, 160);
  floor.material.color.set(dark ? '#16191d' : '#ececea');
  hemi.intensity = dark ? 0.9 : 1.4;
  idleColor = new THREE.Color(dark ? '#5a5d63' : '#b4b4ba');
  for (const x of agents.values()) if (x.status === 'idle') x.light.material.color.copy(idleColor);
  core.material.color.set(t.accent);
  core.material.emissive.set(t.accent);
  shell.material.color.set(t.accent);
  renderer.setPixelRatio(Math.min(devicePixelRatio, t.quality === 'low' ? 1 : 2));
  const css = document.documentElement.style;
  css.setProperty('--bg', bg);
  css.setProperty('--ink', dark ? '#ececee' : '#1c1c1e');
  css.setProperty('--dim', dark ? '#9a9aa2' : '#6b6b70');
  css.setProperty('--chip', dark ? 'rgba(22,24,28,0.85)' : 'rgba(255,255,255,0.85)');
  css.setProperty('--line', dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
}

// ---------- handoffs: a spark travels from one agent to the next ----------
const sparks = [];
function spark(from, to) {
  if (!from || !to) return;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({ color: WORKING }));
  scene.add(mesh);
  sparks.push({ mesh, a: from.group.position.clone(), b: to.group.position.clone(), t: 0 });
}
Athena.onEvent((e) => {
  if (e.kind === 'handoff') spark(agents.get(`${e.teamId}:${e.from}`), agents.get(`${e.teamId}:${e.to}`));
});

// ---------- picking ----------
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pickAt(ev) {
  pointer.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  return ray.intersectObjects(pickables, false)[0]?.object.userData.pick || null;
}
let down = null;
renderer.domElement.addEventListener('pointerdown', (ev) => (down = [ev.clientX, ev.clientY]));
renderer.domElement.addEventListener('click', (ev) => {
  // (a drag turns the camera; only a click picks)
  if (down && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return;
  const p = pickAt(ev);
  if (p) Athena.pick(p.kind, p.id);
});
renderer.domElement.addEventListener('contextmenu', (ev) => {
  const p = pickAt(ev);
  if (!p) return;
  ev.preventDefault();
  Athena.menu(p.kind, p.id, ev.clientX, ev.clientY);
});
let hovered = null;
renderer.domElement.addEventListener('pointermove', (ev) => {
  const p = pickAt(ev);
  const key = p ? `${p.kind}:${p.id || ''}` : null;
  if (key === hovered) return;
  hovered = key;
  renderer.domElement.style.cursor = p ? 'pointer' : '';
  Athena.hover(p?.kind || null, p?.id);
});

// ---------- the loop ----------
const timer = new THREE.Timer();
const at = new THREE.Vector3();
function place(el, obj, lift) {
  at.copy(obj.position)
    .setY(obj.position.y + lift)
    .project(camera);
  const visible = at.z < 1;
  el.style.display = visible ? '' : 'none';
  if (visible)
    el.style.transform = `translate(${((at.x + 1) / 2) * innerWidth}px, ${((1 - at.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
}
function frame() {
  if (Athena.paused) return;
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  const speed = reduced ? 0.25 : 1;
  const busy = state?.agents.some((a) => a.status === 'working');
  const needs = state?.brain.status === 'needs';
  shell.rotation.y += dt * (busy ? 0.6 : 0.15) * speed;
  shell.rotation.x += dt * 0.05 * speed;
  core.scale.setScalar(1 + Math.sin(t * (busy ? 4 : 1.5) * speed) * (busy ? 0.06 : 0.02));
  core.material.emissiveIntensity = needs ? 0.4 + 0.4 * Math.abs(Math.sin(t * 3)) : 0.8;
  for (const x of agents.values()) {
    const bob = x.status === 'working' ? Math.abs(Math.sin(t * 5 * speed + x.group.position.x)) * 0.25 : 0;
    x.body.position.y = 0.95 + bob;
    x.light.position.y = 2.25 + bob;
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.t += dt * 1.2 * speed;
    s.mesh.position.lerpVectors(s.a, s.b, Math.min(s.t, 1)).setY(1.5 + Math.sin(Math.min(s.t, 1) * Math.PI) * 3);
    if (s.t >= 1) {
      scene.remove(s.mesh);
      sparks.splice(i, 1);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  for (const x of teams.values()) place(x.label, x.group, 0.6);
  for (const x of agents.values()) place(x.label, x.group, 2.7);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
Athena.onPause((paused) => {
  if (!paused) {
    timer.update();
    frame();
  }
});
Athena.onTheme(theme);
Athena.onState(draw);
// a picture for builders: drawn now, so the canvas still holds it when it is read
Athena.setCapture(() => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
});
theme({ theme: 'light', accent: '#5b6cff', reducedMotion: false, quality: 'medium' });
frame();
Athena.ready();

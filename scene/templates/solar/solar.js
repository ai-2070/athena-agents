// The solar system: a sample scene. The Brain is the sun, each team a planet on its own orbit, each agent a moon
// of its team's planet that brightens and speeds up while it works and gets an amber ring when it needs you.
// Agents in no team are small satellites close to the sun. The Station draws the labels (Athena.anchors).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Athena } from '/scene-lib/athena-scene.js';

const NEEDS = new THREE.Color('#ffb02e');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 30, 40);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 14;
controls.maxDistance = 220;
const ambient = new THREE.AmbientLight(0xffffff, 0.25);
const sunLight = new THREE.PointLight(0xfff1d6, 900, 0, 1.6);
scene.add(ambient, sunLight);

// stars
const STARS = 1500;
const starPos = new Float32Array(STARS * 3);
for (let i = 0; i < STARS; i++) {
  const v = new THREE.Vector3().randomDirection().multiplyScalar(300 + Math.random() * 200);
  starPos.set([v.x, v.y, v.z], i * 3);
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.2, sizeAttenuation: false }));
scene.add(stars);

// ---------- the Brain: the sun ----------
const sun = new THREE.Mesh(new THREE.SphereGeometry(3.2, 48, 32), new THREE.MeshBasicMaterial());
sun.userData.pick = { kind: 'brain' };
// the corona: a soft glow drawn on a canvas, always facing the camera
const glowCanvas = document.createElement('canvas');
glowCanvas.width = glowCanvas.height = 128;
const g = glowCanvas.getContext('2d');
const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
grad.addColorStop(0, 'rgba(255,255,255,1)');
grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
grad.addColorStop(1, 'rgba(255,255,255,0)');
g.fillStyle = grad;
g.fillRect(0, 0, 128, 128);
const corona = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
corona.scale.setScalar(16);
scene.add(sun, corona);

// ---------- planets and moons, kept by id ----------
const planets = new Map(); // team id -> { group, body, orbit, radius, angle }
const moons = new Map(); // key -> { group, body, ring, agent, planet, angle, dist }
const pickables = [sun];

let orbitColor = '#8fa0c0';
function orbitLine(radius) {
  const pts = Array.from({ length: 129 }, (_, i) => {
    const a = (i / 128) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  });
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: orbitColor, transparent: true, opacity: 0.25 }),
  );
}

function planetFor(t, i, n) {
  const radius = 14 + i * 9;
  let p = planets.get(t.id);
  if (!p || p.radius !== radius) {
    if (p) {
      scene.remove(p.group, p.orbit);
      pickables.splice(pickables.indexOf(p.body), 1);
    }
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1.6 + Math.min(t.members.length, 8) * 0.12, 32, 24),
      new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    );
    body.userData.pick = { kind: 'team', id: t.id };
    group.add(body);
    const orbit = orbitLine(radius);
    scene.add(group, orbit);
    pickables.push(body);
    p = { group, body, orbit, radius, angle: p?.angle ?? (i / Math.max(n, 1)) * Math.PI * 2 };
    planets.set(t.id, p);
  }
  p.body.material.color.set(t.color);
  p.speed = 0.06 / Math.sqrt(1 + i);
  return p;
}

function moonFor(key, a, planet, j) {
  let m = moons.get(key);
  if (!m) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 20, 14),
      new THREE.MeshStandardMaterial({ roughness: 0.6, emissiveIntensity: 0 }),
    );
    body.userData.pick = { kind: 'agent', id: a.id };
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.07, 8, 32),
      new THREE.MeshBasicMaterial({ color: NEEDS, transparent: true }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(body, ring);
    scene.add(group);
    pickables.push(body);
    m = { group, body, ring, angle: j * 1.9 };
    moons.set(key, m);
  }
  m.agent = a;
  m.planet = planet;
  m.dist = planet ? 3.2 + (j % 4) * 0.9 : 7.5 + (j % 3) * 1.4;
  m.body.material.color.set(a.color);
  m.body.material.emissive.set(a.color);
  return m;
}

function drop(map, keep) {
  for (const [k, x] of map) {
    if (keep.has(k)) continue;
    scene.remove(x.group);
    if (x.orbit) scene.remove(x.orbit);
    const i = pickables.indexOf(x.body);
    if (i >= 0) pickables.splice(i, 1);
    map.delete(k);
  }
}

let state = null;
function draw(s) {
  state = s;
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const keepPlanets = new Set();
  const keepMoons = new Set();
  s.teams.forEach((t, i) => {
    const p = planetFor(t, i, s.teams.length);
    keepPlanets.add(t.id);
    t.members.forEach((id, j) => {
      const a = byId.get(id);
      if (!a) return;
      moonFor(`${t.id}:${id}`, a, p, j);
      keepMoons.add(`${t.id}:${id}`);
    });
  });
  s.agents
    .filter((a) => !a.teams.length)
    .forEach((a, j) => {
      moonFor(`-:${a.id}`, a, null, j);
      keepMoons.add(`-:${a.id}`);
    });
  drop(planets, keepPlanets);
  drop(moons, keepMoons);
}

// ---------- light and dark ----------
let reduced = false;
function theme(t) {
  const dark = t.theme === 'dark';
  reduced = t.reducedMotion;
  const sky = new THREE.Color(dark ? '#05060a' : '#e9edf5');
  scene.background = sky;
  document.body.style.background = `#${sky.getHexString()}`;
  stars.material.color.set(dark ? '#ffffff' : '#9aa3b5');
  ambient.intensity = dark ? 0.25 : 0.9;
  const accent = new THREE.Color(t.accent);
  sun.material.color.copy(accent).lerp(new THREE.Color('#fff4d6'), 0.55);
  corona.material.color.copy(accent);
  orbitColor = dark ? '#8fa0c0' : '#55607a';
  for (const p of planets.values()) p.orbit.material.color.set(orbitColor);
  renderer.setPixelRatio(Math.min(devicePixelRatio, t.quality === 'low' ? 1 : t.quality === 'medium' ? 1.5 : 2));
}

// ---------- handoffs: a comet from one moon to the next ----------
const comets = [];
Athena.onEvent((e) => {
  if (e.kind !== 'handoff') return;
  const a = moons.get(`${e.teamId}:${e.from}`);
  const b = moons.get(`${e.teamId}:${e.to}`);
  if (!a || !b) return;
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  scene.add(m);
  comets.push({ m, a, b, t: 0 });
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
const v = new THREE.Vector3();
function screen(obj, lift) {
  v.setFromMatrixPosition(obj.matrixWorld);
  v.y += lift;
  v.project(camera);
  if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
}
function frame() {
  if (Athena.paused) return;
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  const k = reduced ? 0.2 : 1;
  const bs = state?.brain.status;
  const beat = 1 + Math.sin(t * (bs === 'thinking' ? 4 : 1.2) * k) * (bs === 'thinking' ? 0.06 : 0.02);
  corona.scale.setScalar(16 * beat);
  corona.material.opacity = bs === 'needs' ? 0.4 + Math.abs(Math.sin(t * 3)) * 0.4 : 0.55;
  if (bs === 'needs') corona.material.color.lerp(NEEDS, 0.05);
  else if (Athena.theme) corona.material.color.lerp(new THREE.Color(Athena.theme.accent), 0.05);
  for (const p of planets.values()) {
    p.angle += dt * p.speed * k;
    p.group.position.set(Math.cos(p.angle) * p.radius, 0, Math.sin(p.angle) * p.radius);
    p.body.rotation.y += dt * 0.3 * k;
  }
  for (const m of moons.values()) {
    const st = m.agent.status;
    m.angle += dt * (st === 'working' ? 1.6 : st === 'needs' ? 0.1 : 0.4) * k;
    const c = m.planet ? m.planet.group.position : sun.position;
    m.group.position.set(
      c.x + Math.cos(m.angle) * m.dist,
      Math.sin(m.angle * 0.7) * 0.4,
      c.z + Math.sin(m.angle) * m.dist,
    );
    m.body.material.emissiveIntensity = st === 'working' ? 0.8 + Math.sin(t * 6) * 0.2 : 0;
    m.ring.visible = st === 'needs';
    m.ring.material.opacity = 0.6 + Math.abs(Math.sin(t * 3)) * 0.4;
  }
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    c.t += dt * 0.8 * k;
    c.m.position.lerpVectors(c.a.group.position, c.b.group.position, Math.min(c.t, 1));
    c.m.position.y += Math.sin(Math.min(c.t, 1) * Math.PI) * 1.5;
    if (c.t >= 1) {
      scene.remove(c.m);
      comets.splice(i, 1);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  const items = [];
  const sp = screen(sun, 5.5);
  if (sp) items.push({ kind: 'brain', ...sp });
  for (const [id, p] of planets) {
    const at = screen(p.group, 2.6);
    if (at) items.push({ kind: 'team', id, ...at });
  }
  for (const m of moons.values()) {
    const at = screen(m.group, 1);
    if (at) items.push({ kind: 'agent', id: m.agent.id, ...at });
  }
  Athena.anchors(items);
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
Athena.setCapture(() => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
});
theme({ theme: 'dark', accent: '#7aa2ff', reducedMotion: false, quality: 'medium' });
frame();
Athena.ready();

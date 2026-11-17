// The underwater garden: a sample scene. Each team is a coral reef, each agent a fish that circles its reef (faster
// while it works, rising with an amber glow when it needs you), the Brain a jellyfish in the middle. Agents in no
// team swim around the jellyfish. The Station draws the labels (Athena.anchors), so this scene draws none.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Athena } from '/scene-lib/athena-scene.js';

const NEEDS = new THREE.Color('#ffb02e');
const WORKING = new THREE.Color('#7dffb0');

// ---------- renderer, camera, water ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 400);
camera.position.set(0, 26, 40);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 3, 0);
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 10;
controls.maxDistance = 110;
const hemi = new THREE.HemisphereLight(0xbfefff, 0x1d3b2a, 1.2);
const sun = new THREE.DirectionalLight(0xdff6ff, 1.3);
sun.position.set(-10, 40, 15);
scene.add(hemi, sun);

// the seabed: gentle dunes
const bedGeo = new THREE.PlaneGeometry(220, 220, 120, 120);
bedGeo.rotateX(-Math.PI / 2);
const pos = bedGeo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  pos.setY(i, Math.sin(x * 0.11) * 0.6 + Math.cos(z * 0.09) * 0.7 + Math.sin((x + z) * 0.05) * 0.9 - 1);
}
bedGeo.computeVertexNormals();
const bed = new THREE.Mesh(bedGeo, new THREE.MeshStandardMaterial({ roughness: 1 }));
scene.add(bed);

// seaweed that sways: one instanced mesh, matrices updated each frame
const WEEDS = 260;
const weedGeo = new THREE.ConeGeometry(0.12, 3.4, 5, 4);
weedGeo.translate(0, 1.7, 0);
const weeds = new THREE.InstancedMesh(weedGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), WEEDS);
const weedSpots = [];
for (let i = 0; i < WEEDS; i++) {
  const r = 8 + Math.random() * 70;
  const a = Math.random() * Math.PI * 2;
  weedSpots.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, h: 0.6 + Math.random() * 1.4, phase: Math.random() * 6 });
}
scene.add(weeds);

// rising bubbles
const BUBBLES = 400;
const bubblePos = new Float32Array(BUBBLES * 3);
for (let i = 0; i < BUBBLES; i++) {
  bubblePos[i * 3] = (Math.random() - 0.5) * 120;
  bubblePos[i * 3 + 1] = Math.random() * 40;
  bubblePos[i * 3 + 2] = (Math.random() - 0.5) * 120;
}
const bubbleGeo = new THREE.BufferGeometry();
bubbleGeo.setAttribute('position', new THREE.BufferAttribute(bubblePos, 3));
const bubbles = new THREE.Points(
  bubbleGeo,
  new THREE.PointsMaterial({ size: 0.25, transparent: true, opacity: 0.55, depthWrite: false }),
);
scene.add(bubbles);

// ---------- the Brain: a jellyfish ----------
const jelly = new THREE.Group();
const bell = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
  new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.75, emissiveIntensity: 0.9, roughness: 0.2 }),
);
bell.userData.pick = { kind: 'brain' };
jelly.add(bell);
const tentacles = [];
for (let i = 0; i < 10; i++) {
  const pts = Array.from({ length: 12 }, (_, j) => new THREE.Vector3(0, -j * 0.45, 0));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }),
  );
  const a = (i / 10) * Math.PI * 2;
  line.position.set(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5);
  line.userData.phase = a;
  jelly.add(line);
  tentacles.push(line);
}
jelly.position.y = 9;
scene.add(jelly);

// ---------- reefs and fish, kept by id ----------
const reefs = new Map(); // team id -> { group, parts, center, radius }
const fish = new Map(); // key -> { group, body, glow, agent, team, angle, height }
const pickables = [bell];

function reefFor(t, at) {
  let r = reefs.get(t.id);
  if (!r) {
    const group = new THREE.Group();
    const parts = [];
    // a few corals: branching cylinders, round brain corals, fan cones (the same shapes, the team's colour)
    let seed = [...t.id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 14; i++) {
      const kind = i % 3;
      const geo =
        kind === 0
          ? new THREE.CylinderGeometry(0.15, 0.3, 1.5 + rand() * 2.5, 6)
          : kind === 1
            ? new THREE.SphereGeometry(0.6 + rand() * 0.7, 12, 10)
            : new THREE.ConeGeometry(0.7 + rand() * 0.5, 1.6 + rand() * 1.5, 7);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.7 }));
      const a = rand() * Math.PI * 2;
      const d = rand() * 2.6;
      m.position.set(Math.cos(a) * d, kind === 1 ? 0.2 : 0.8, Math.sin(a) * d);
      m.rotation.set((rand() - 0.5) * 0.6, rand() * 3, (rand() - 0.5) * 0.6);
      m.userData.pick = { kind: 'team', id: t.id };
      m.userData.shade = 0.75 + rand() * 0.5;
      group.add(m);
      parts.push(m);
      pickables.push(m);
    }
    scene.add(group);
    r = { group, parts };
    reefs.set(t.id, r);
  }
  const c = new THREE.Color(t.color);
  for (const m of r.parts) m.material.color.copy(c).multiplyScalar(m.userData.shade);
  r.group.position.copy(at);
  return r;
}

function fishFor(key, a, team) {
  let f = fish.get(key);
  if (!f) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
    );
    body.scale.set(1.6, 0.8, 0.7);
    body.userData.pick = { kind: 'agent', id: a.id };
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.8, 4), body.material);
    tail.rotation.z = Math.PI / 2;
    tail.position.x = -1.1;
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    group.add(body, tail, glow);
    scene.add(group);
    pickables.push(body);
    f = { group, body, tail, glow, angle: Math.random() * Math.PI * 2, rise: 0 };
    fish.set(key, f);
  }
  f.agent = a;
  f.team = team;
  f.body.material.color.set(a.color);
  return f;
}

function drop(map, keep) {
  for (const [k, x] of map) {
    if (keep.has(k)) continue;
    scene.remove(x.group);
    for (const o of [...(x.parts || []), x.body].filter(Boolean)) {
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
  const keepReefs = new Set();
  const keepFish = new Set();
  const n = Math.max(s.teams.length, 1);
  const ring = 14 + n * 2.4;
  s.teams.forEach((t, i) => {
    const angle = (i / n) * Math.PI * 2 + 0.4;
    const at = new THREE.Vector3(Math.cos(angle) * ring, 0, Math.sin(angle) * ring);
    reefFor(t, at);
    keepReefs.add(t.id);
    for (const id of t.members) {
      const a = byId.get(id);
      if (!a) continue;
      fishFor(`${t.id}:${id}`, a, t);
      keepFish.add(`${t.id}:${id}`);
    }
  });
  for (const a of s.agents.filter((x) => !x.teams.length)) {
    fishFor(`-:${a.id}`, a, null);
    keepFish.add(`-:${a.id}`);
  }
  drop(reefs, keepReefs);
  drop(fish, keepFish);
}

// ---------- light and dark: shallow turquoise by day, deep blue at night ----------
let reduced = false;
function theme(t) {
  const dark = t.theme === 'dark';
  reduced = t.reducedMotion;
  const water = new THREE.Color(dark ? '#06202e' : '#3f9fb5');
  scene.background = water;
  scene.fog = new THREE.FogExp2(water, dark ? 0.022 : 0.016);
  document.body.style.background = `#${water.getHexString()}`;
  bed.material.color.set(dark ? '#3b4a3f' : '#d9c79a');
  weeds.material.color.set(dark ? '#1f5a3a' : '#3f8f4a');
  bubbles.material.color.set(dark ? '#9fdcff' : '#ffffff');
  hemi.intensity = dark ? 0.7 : 1.3;
  sun.intensity = dark ? 0.5 : 1.4;
  const accent = new THREE.Color(t.accent);
  bell.material.color.copy(accent);
  bell.material.emissive.copy(accent);
  for (const l of tentacles) l.material.color.copy(accent);
  renderer.setPixelRatio(Math.min(devicePixelRatio, t.quality === 'low' ? 1 : t.quality === 'medium' ? 1.5 : 2));
}

// ---------- handoffs: a trail of bubbles from one fish to the other ----------
const trails = [];
Athena.onEvent((e) => {
  if (e.kind !== 'handoff') return;
  const a = fish.get(`${e.teamId}:${e.from}`);
  const b = fish.get(`${e.teamId}:${e.to}`);
  if (!a || !b) return;
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8),
    new THREE.MeshBasicMaterial({ color: WORKING, transparent: true }),
  );
  scene.add(m);
  trails.push({ m, a, b, t: 0 });
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
const tmp = new THREE.Object3D();
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
  const k = reduced ? 0.25 : 1;
  // seaweed
  for (let i = 0; i < WEEDS; i++) {
    const w = weedSpots[i];
    tmp.position.set(w.x, -0.6, w.z);
    tmp.rotation.set(Math.sin(t * 0.8 * k + w.phase) * 0.25, 0, Math.cos(t * 0.6 * k + w.phase) * 0.2);
    tmp.scale.set(1, w.h, 1);
    tmp.updateMatrix();
    weeds.setMatrixAt(i, tmp.matrix);
  }
  weeds.instanceMatrix.needsUpdate = true;
  // bubbles rise and wrap
  for (let i = 0; i < BUBBLES; i++) {
    bubblePos[i * 3 + 1] += dt * (0.8 + (i % 5) * 0.2) * k;
    if (bubblePos[i * 3 + 1] > 40) bubblePos[i * 3 + 1] = 0;
  }
  bubbleGeo.attributes.position.needsUpdate = true;
  // the jellyfish breathes, faster while the Brain thinks; amber when it needs you
  const bs = state?.brain.status;
  const beat = Math.sin(t * (bs === 'thinking' ? 3.5 : 1.4) * k);
  bell.scale.set(1 + beat * 0.06, 1 - beat * 0.08, 1 + beat * 0.06);
  jelly.position.y = 9 + Math.sin(t * 0.5 * k) * 0.6;
  bell.material.emissiveIntensity = bs === 'needs' ? 0.4 + Math.abs(Math.sin(t * 3)) * 0.8 : 0.9;
  if (bs === 'needs') bell.material.emissive.lerp(NEEDS, 0.05);
  else if (Athena.theme) bell.material.emissive.lerp(new THREE.Color(Athena.theme.accent), 0.05);
  for (const l of tentacles) {
    const p = l.geometry.attributes.position;
    for (let j = 0; j < p.count; j++) p.setX(j, Math.sin(t * 1.5 * k + l.userData.phase + j * 0.5) * j * 0.05);
    p.needsUpdate = true;
  }
  // fish circle their reef (or the jellyfish)
  for (const f of fish.values()) {
    const st = f.agent.status;
    const speed = st === 'working' ? 1.1 : st === 'needs' ? 0.15 : 0.3;
    f.angle += dt * speed * k;
    const home = f.team ? reefs.get(f.team.id)?.group.position : jelly.position;
    const radius = f.team ? 4.5 : 6.5;
    f.rise += ((st === 'needs' ? 5 : 0) - f.rise) * Math.min(1, dt * 2);
    const y = (f.team ? 3 : 7) + f.rise + Math.sin(t * 1.3 + f.angle * 3) * 0.3;
    if (home) f.group.position.set(home.x + Math.cos(f.angle) * radius, y, home.z + Math.sin(f.angle) * radius);
    f.group.rotation.y = -f.angle - Math.PI / 2;
    f.tail.rotation.y = Math.sin(t * (st === 'working' ? 14 : 5) * k) * 0.5;
    f.glow.material.color.copy(st === 'needs' ? NEEDS : WORKING);
    f.glow.material.opacity = st === 'idle' ? 0 : 0.18 + Math.abs(Math.sin(t * 4)) * (st === 'needs' ? 0.25 : 0.08);
  }
  for (let i = trails.length - 1; i >= 0; i--) {
    const tr = trails[i];
    tr.t += dt * 0.9 * k;
    tr.m.position.lerpVectors(tr.a.group.position, tr.b.group.position, Math.min(tr.t, 1));
    tr.m.position.y += Math.sin(Math.min(tr.t, 1) * Math.PI) * 2;
    tr.m.material.opacity = 1 - Math.max(0, tr.t - 0.8) * 5;
    if (tr.t >= 1) {
      scene.remove(tr.m);
      trails.splice(i, 1);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  // where the Station puts its labels
  const items = [];
  const jp = screen(bell, 3);
  if (jp) items.push({ kind: 'brain', ...jp });
  for (const [id, r] of reefs) {
    const p = screen(r.group, 4.5);
    if (p) items.push({ kind: 'team', id, ...p });
  }
  for (const f of fish.values()) {
    const p = screen(f.group, 1.4);
    if (p) items.push({ kind: 'agent', id: f.agent.id, ...p });
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

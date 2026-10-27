// The Station in the voxel look: sky, fog, a sun with soft shadows, sky light from above and ground light
// from below, the finishing passes (web/voxel/post.ts), and voxel volumes drawn from the mesher. The
// classic lights are hidden while it is on and come back when it is disposed, so the classic map is
// exactly as it was.
import * as THREE from 'three';
import { meshRegion } from './mesher.ts';
import type { MeshPart, ObjectPart, RenderClass } from './mesher.ts';
import { envPreset, sunDirection } from '../../shared/worldenv.ts';
import { createPost } from './post.ts';
import type { Post } from './post.ts';
import { CHUNK, countVoxels, parseChunkKey } from '../../shared/voxel.ts';
import type { Vec3i, Volume } from '../../shared/voxel.ts';
import type { VoxelMaterial, WorldEnvironment, WorldQuality } from '../../shared/types.ts';

export interface VolumeStats {
  voxels: number;
  faces: number;
  meshes: number;
  /** time spent meshing, ms */
  ms: number;
}

export interface WorldView {
  render(): void;
  setSize(w: number, h: number): void;
  setEnvironment(env: WorldEnvironment): void;
  readonly environment: WorldEnvironment;
  /** Shadows for the Station's own meshes, and the sun's shadow box and the fog fitted to the map's size. */
  adopt(world: THREE.Object3D, radius: number): void;
  addVolume(id: string, vol: Volume, palette: VoxelMaterial[], at: THREE.Vector3, region?: number): VolumeStats;
  /** Meshed parts (from the mesher or its worker) as one group under `id`, replacing what was there. */
  addParts(id: string, parts: ObjectPart[]): THREE.Group;
  removeVolume(id: string): void;
  /** Frames per second over the next few seconds (and the slowest frame, ms). */
  measure(seconds: number): Promise<{ fps: number; worstMs: number; frames: number }>;
  dispose(): void;
}

export interface WorldViewOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  quality: WorldQuality;
  /** the classic map's lights and floor dots: hidden while the voxel look is on */
  classic: THREE.Object3D[];
  w: number;
  h: number;
  env?: WorldEnvironment;
}

const SHADOW_MAP: Record<WorldQuality, number> = { low: 0, medium: 2048, high: 4096 };

// Voxel colors are stored as written (sRGB, with the creases darkened); the shader turns them into
// linear light so they come out the color they were picked as.
function srgbVertexColors<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\n  vColor.rgb = pow(vColor.rgb, vec3(2.2));\n#endif');
  };
  m.customProgramCacheKey = () => 'voxel-srgb-colors';
  return m;
}

function skyTexture(env: WorldEnvironment): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, env.sky.top);
  g.addColorStop(0.62, env.sky.horizon);
  g.addColorStop(1, env.sky.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Every material in a scene recompiles (shadows were switched on or off). */
function recompile(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
  });
}

export function createWorldView(o: WorldViewOptions): WorldView {
  const { renderer, scene, camera, quality } = o;
  let env = o.env || envPreset('station');
  let radius = 40;
  const shadowSize = SHADOW_MAP[quality];

  for (const c of o.classic) c.visible = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = shadowSize > 0;
  // (soft through shadow.radius: three.js 0.18x dropped PCFSoftShadowMap)
  renderer.shadowMap.type = THREE.PCFShadowMap;
  recompile(scene);

  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.castShadow = shadowSize > 0;
  if (shadowSize) {
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
  }
  const voxels = new THREE.Group();
  scene.add(hemi, sun, sun.target, voxels);
  let sky: THREE.CanvasTexture | null = null;

  const mats: Record<RenderClass, THREE.Material> = {
    opaque: srgbVertexColors(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 })),
    // brighter than white, so the glow pass picks it up
    emissive: srgbVertexColors(new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.9, 1.9, 1.9) })),
    transparent: srgbVertexColors(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.62, depthWrite: false })),
  };

  let post: Post | null = quality === 'low' ? null : createPost(renderer, scene, camera, quality, o.w, o.h);

  const fit = () => {
    const [dx, dy, dz] = sunDirection(env.sun.azimuth, env.sun.elevation);
    const r = radius + 10;
    sun.position.set(dx * r * 2.5, dy * r * 2.5, dz * r * 2.5);
    sun.target.position.set(0, 0, 0);
    const cam = sun.shadow.camera;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 5 });
    cam.updateProjectionMatrix();
    // the camera stands 300 from what it looks at: things behind that fade into the sky
    if (env.fog.density > 0.01) {
      const fog = scene.fog instanceof THREE.Fog ? scene.fog : (scene.fog = new THREE.Fog(0));
      fog.color.set(env.fog.color);
      fog.near = 300 + radius * 0.2;
      fog.far = 300 + radius * (1.4 + 5 * (1 - env.fog.density));
    } else scene.fog = null;
  };

  const setEnvironment = (e: WorldEnvironment) => {
    env = e;
    sky?.dispose();
    sky = skyTexture(e);
    scene.background = sky;
    hemi.color.set(e.ambient.sky);
    hemi.groundColor.set(e.ambient.ground);
    hemi.intensity = e.ambient.intensity;
    sun.color.set(e.sun.color);
    sun.intensity = e.sun.intensity;
    renderer.toneMappingExposure = e.exposure;
    post?.setLook({ bloom: e.bloom, tiltShift: e.tiltShift });
    fit();
  };
  setEnvironment(env);

  const volumes = new Map<string, THREE.Group>();
  const removeVolume = (id: string) => {
    const g = volumes.get(id);
    if (!g) return;
    voxels.remove(g);
    g.traverse((n) => (n as THREE.Mesh).geometry?.dispose());
    volumes.delete(id);
  };
  // meshed parts → one group of meshes (replacing what was there under that id)
  const addParts = (id: string, parts: ObjectPart[]): THREE.Group => {
    removeVolume(id);
    const g = new THREE.Group();
    for (const p of parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3, true));
      geo.setAttribute('color', new THREE.BufferAttribute(p.colors, 3, true));
      geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[p.cls]);
      mesh.position.set(p.min[0], p.min[1], p.min[2]).multiplyScalar(p.voxelSize);
      mesh.scale.setScalar(p.voxelSize);
      mesh.castShadow = p.cls !== 'transparent';
      mesh.receiveShadow = p.cls !== 'emissive';
      g.add(mesh);
    }
    voxels.add(g);
    volumes.set(id, g);
    return g;
  };

  // frame timing for measure()
  let frames: number[] | null = null;
  let last = 0;

  return {
    get environment() {
      return env;
    },
    render() {
      if (frames) {
        const now = performance.now();
        if (last) frames.push(now - last);
        last = now;
      }
      if (post) post.render();
      else renderer.render(scene, camera);
    },
    setSize(w, h) {
      post?.setSize(w, h);
    },
    setEnvironment,
    adopt(world, r) {
      radius = Math.max(20, r);
      world.traverse((n) => {
        const m = n as THREE.Mesh;
        if (m.isMesh && m.material instanceof THREE.MeshStandardMaterial) m.castShadow = m.receiveShadow = true;
      });
      fit();
    },
    addVolume(id, vol, palette, at, region = 32) {
      const started = performance.now();
      const parts: ObjectPart[] = [];
      // the regions that hold any chunk
      const regions = new Set<string>();
      for (const k of vol.chunks.keys()) regions.add(parseChunkKey(k).map((c) => Math.floor((c * CHUNK) / region)).join(','));
      for (const key of regions) {
        const min = key.split(',').map((n) => Number(n) * region) as Vec3i;
        for (const [cls, p] of Object.entries(meshRegion(vol, min, [region, region, region], palette)) as [RenderClass, MeshPart][]) parts.push({ ...p, cls, voxelSize: vol.voxelSize, min });
      }
      const g = addParts(id, parts);
      g.position.copy(at);
      return { voxels: countVoxels(vol), faces: parts.reduce((n, p) => n + p.faces, 0), meshes: g.children.length, ms: Math.round(performance.now() - started) };
    },
    addParts,
    removeVolume,
    async measure(seconds) {
      // a second to settle first: the first frames compile shaders
      await new Promise((r) => setTimeout(r, 1000));
      frames = [];
      last = 0;
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const f = frames || [];
      frames = null;
      const total = f.reduce((a, b) => a + b, 0);
      return { fps: total ? Math.round((f.length / total) * 10000) / 10 : 0, worstMs: Math.round(Math.max(0, ...f)), frames: f.length };
    },
    dispose() {
      for (const id of [...volumes.keys()]) removeVolume(id);
      scene.remove(hemi, sun, sun.target, voxels);
      sun.shadow.map?.dispose();
      for (const m of Object.values(mats)) m.dispose();
      post?.dispose();
      post = null;
      sky?.dispose();
      scene.background = null;
      scene.fog = null;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = false;
      for (const c of o.classic) c.visible = true;
      recompile(scene);
    },
  };
}

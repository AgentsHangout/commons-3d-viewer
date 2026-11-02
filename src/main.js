import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createWaterSystem } from './waterShader.js';

let waterSystem = null;

// Setup Renderer, Scene & Camera
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f141d);
scene.fog = new THREE.FogExp2(0x0f141d, 0.007);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 600);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.04;

const urlParams = new URLSearchParams(window.location.search);
const camParam = urlParams.get('cam');
if (camParam === 'cabin') {
  camera.position.set(55, 6, 66);
  controls.target.set(55, 0, 57);
} else if (camParam === 'studio') {
  camera.position.set(22, 6, 66);
  controls.target.set(22, 0, 57);
} else if (camParam === 'lake') {
  camera.position.set(31, 14, 48);
  controls.target.set(31, 0, 30);
} else {
  camera.position.set(60, 45, 115);
  controls.target.set(60, 0, 81);
}
controls.update();

// Lighting
const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x223344, 0.75);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xfffaed, 1.4);
dirLight.position.set(80, 100, 60);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 10;
dirLight.shadow.camera.far = 250;
const d = 90;
dirLight.shadow.camera.left = -d;
dirLight.shadow.camera.right = d;
dirLight.shadow.camera.top = d;
dirLight.shadow.camera.bottom = -d;
dirLight.shadow.bias = -0.0004;
scene.add(dirLight);

// Palette definitions
const TERRAIN_PALETTE = {
  g: 0x3d7332, // Grass
  f: 0x1f4720, // Forest
  w: 0x225588, // Water
  s: 0xc4a86b, // Sand
  h: 0x5e6353  // Hill
};

const BUILDING_COLORS = {
  house: 0xb56538,
  studio: 0x6b8299,
  workshop: 0x8a3832,
  cafe: 0xd48b48,
  club: 0x803e91,
  lounge: 0x546e7a,
  bar: 0x9c4236,
  office: 0x455a64,
  library: 0x3f51b5,
  green: 0x2e7d32,
  square: 0x78909c,
  road: 0x3a3f47
};

// 4-Neighbor Road Autotiling Lookup Table (per PLAN.md Section 4.2 & verified coordinate transforms)
const ROAD_AUTOTILE_TABLE = {
  0:  { model: 'road_straight', rot: 0 },              // Isolated single tile fallback
  1:  { model: 'road_deadend',  rot: Math.PI },        // Connects North (-Z) only
  2:  { model: 'road_deadend',  rot: Math.PI / 2 },    // Connects East (+X) only
  3:  { model: 'road_corner',   rot: 0 },              // Connects North (-Z) + East (+X)
  4:  { model: 'road_deadend',  rot: 0 },              // Connects South (+Z) only
  5:  { model: 'road_straight', rot: 0 },              // Connects North (-Z) + South (+Z)
  6:  { model: 'road_corner',   rot: -Math.PI / 2 },   // Connects East (+X) + South (+Z)
  7:  { model: 'road_t_cross',  rot: 0 },              // Connects North (-Z) + East (+X) + South (+Z)
  8:  { model: 'road_deadend',  rot: -Math.PI / 2 },   // Connects West (-X) only
  9:  { model: 'road_corner',   rot: Math.PI / 2 },    // Connects West (-X) + North (-Z)
  10: { model: 'road_straight', rot: Math.PI / 2 },    // Connects East (+X) + West (-X)
  11: { model: 'road_t_cross',  rot: Math.PI / 2 },    // Connects West (-X) + North (-Z) + East (+X)
  12: { model: 'road_corner',   rot: Math.PI },        // Connects South (+Z) + West (-X)
  13: { model: 'road_t_cross',  rot: Math.PI },        // Connects South (+Z) + West (-X) + North (-Z)
  14: { model: 'road_t_cross',  rot: -Math.PI / 2 },   // Connects East (+X) + South (+Z) + West (-X)
  15: { model: 'road_cross',    rot: 0 }               // Connects North + East + South + West (4-way)
};

// Seeded PRNG for deterministic placement
function createSeededRandom(seed = 12345) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// GLTF Asset Cache & Loader
const gltfLoader = new GLTFLoader();
const loadedModels = {};

/**
 * Consolidate each GLB model's sub-meshes and primitives into a single BufferGeometry
 * with baked vertex colors, preserved UVs, and model-accurate weighted PBR roughness/metalness.
 * Models ship with multiple primitives (e.g. cabin.glb has 119 primitives).
 * Collapsing to 1 geometry & 1 material allows rendering via a single THREE.InstancedMesh
 * (1 draw call per model type), well under the strict CI budget.
 */
function collapseGltfToSingleMesh(gltfScene, key = '') {
  gltfScene.updateMatrixWorld(true);
  const frontParts = [];
  const doubleParts = [];
  const glassParts = [];
  const matClassifications = {};

  let totalVerts = 0;
  let totalRoughness = 0;
  let totalMetalness = 0;
  let primaryTexture = null;
  let anyHasUV = false;

  // 1. First pass: inspect UV attributes
  gltfScene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (child.geometry.attributes.uv) anyHasUV = true;
  });

  // Helper: detect if a mesh/material is transparent glass
  // In production GLTFs, this matches:
  // - Studio: 'Studio_Glass'
  // - Workshop: 'Workshop_Window_Glass'
  const isGlassPrimitive = (mat, name) => {
    if (!mat) return false;
    const n = (mat.name || '').toLowerCase();
    const cn = (name || '').toLowerCase();
    if (n.includes('glow') || n.includes('lamp') || cn.includes('glow') || cn.includes('lamp')) return false;
    if (mat.alphaMode === 'BLEND') return true;
    if (typeof mat.opacity === 'number' && mat.opacity < 0.95) return true;
    return n === 'studio_glass' || n === 'workshop_window_glass' || cn === 'studio_glass' || cn === 'workshop_window_glass';
  };

  // Helper: detect if a primitive is thin open geometry requiring DoubleSide
  const isExplicitDoubleSided = (mat, meshName) => {
    if (!mat) return false;
    // If authoring explicitly disabled doubleSided, strictly respect FrontSide!
    if (mat.doubleSided === false || mat.side === THREE.FrontSide) return false;

    const m = (mat.name || '').toLowerCase();
    const n = (meshName || '').toLowerCase();

    // Thin open foliage shells
    if (m.includes('needles') || n.includes('needle') || n.includes('tier')) return true;
    // Thin roof eaves and shingles
    if (m.includes('roof_cedar') || n.includes('shingle')) return true;
    // Corrugated roof sheet overhangs
    if (m.includes('roof_corrugated')) return true;
    // Thin steel canopy overhangs and succulent foliage
    if ((m.includes('roof_dark') && n.includes('roof')) || m.includes('foliage') || n.includes('succulent')) return true;
    // Porch brackets, fascia, rails, and trim
    if (m.includes('trim_dark')) return true;

    // Closed polyhedra (logs, stone, brick, foundations, road slabs) default to FrontSide!
    return false;
  };

  // 2. Second pass: partition into front, double, vs glass
  gltfScene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    const isGlass = isGlassPrimitive(mat, child.name);
    const isDoubleSided = !isGlass && isExplicitDoubleSided(mat, child.name);

    if (mat && mat.name) {
      matClassifications[mat.name] = {
        side: isGlass ? THREE.DoubleSide : (isDoubleSided ? THREE.DoubleSide : THREE.FrontSide),
        transparent: isGlass,
        depthWrite: !isGlass
      };
    }

    const color = (mat && mat.color) ? mat.color : new THREE.Color(1, 1, 1);
    const roughness = (mat && typeof mat.roughness === 'number') ? mat.roughness : 0.75;
    const metalness = (mat && typeof mat.metalness === 'number') ? mat.metalness : 0.05;

    if (mat && mat.map && !primaryTexture && !isGlass) primaryTexture = mat.map;

    let geo = child.geometry.clone();
    if (geo.index) geo = geo.toNonIndexed();
    geo.applyMatrix4(child.matrixWorld);

    const count = geo.attributes.position.count;
    if (!isGlass) {
      totalVerts += count;
      totalRoughness += roughness * count;
      totalMetalness += metalness * count;
    }

    const colorArr = new Float32Array(count * 3);
    const hasExistingColor = !!geo.attributes.color;
    for (let i = 0; i < count; i++) {
      if (hasExistingColor) {
        colorArr[i * 3]     = geo.attributes.color.getX(i) * color.r;
        colorArr[i * 3 + 1] = geo.attributes.color.getY(i) * color.g;
        colorArr[i * 3 + 2] = geo.attributes.color.getZ(i) * color.b;
      } else {
        colorArr[i * 3]     = color.r;
        colorArr[i * 3 + 1] = color.g;
        colorArr[i * 3 + 2] = color.b;
      }
    }

    const slim = new THREE.BufferGeometry();
    slim.setAttribute('position', geo.attributes.position.clone());
    if (geo.attributes.normal) {
      slim.setAttribute('normal', geo.attributes.normal.clone());
    } else {
      slim.computeVertexNormals();
    }

    if (anyHasUV) {
      if (geo.attributes.uv) {
        slim.setAttribute('uv', geo.attributes.uv.clone());
      } else {
        slim.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
      }
    }

    slim.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3));
    if (isGlass) {
      glassParts.push(slim);
    } else if (isDoubleSided) {
      doubleParts.push(slim);
    } else {
      frontParts.push(slim);
    }
  });

  if (frontParts.length === 0 && doubleParts.length === 0 && glassParts.length === 0) {
    return gltfScene;
  }

  const mergedFront = frontParts.length > 0 ? mergeGeometries(frontParts, false) : null;
  const mergedDouble = doubleParts.length > 0 ? mergeGeometries(doubleParts, false) : null;
  const mergedGlass = glassParts.length > 0 ? mergeGeometries(glassParts, false) : null;

  // Unified geometric grounding: compute combined minY across all parts
  let minY = Infinity;
  for (const g of [mergedFront, mergedDouble, mergedGlass]) {
    if (g) {
      g.computeBoundingBox();
      if (g.boundingBox) minY = Math.min(minY, g.boundingBox.min.y);
    }
  }
  if (!Number.isFinite(minY)) minY = 0;

  if (Math.abs(minY) > 0.001) {
    if (mergedFront) mergedFront.translate(0, -minY, 0);
    if (mergedDouble) mergedDouble.translate(0, -minY, 0);
    if (mergedGlass) mergedGlass.translate(0, -minY, 0);
  }

  for (const g of [mergedFront, mergedDouble, mergedGlass]) {
    if (g) {
      g.computeBoundingBox();
      g.computeBoundingSphere();
      if (!g.attributes.normal) g.computeVertexNormals();
    }
  }

  const group = new THREE.Group();

  const isRoad = (key && key.startsWith('road')) ||
    (gltfScene.name && gltfScene.name.toLowerCase().includes('road'));
  const avgRoughness = isRoad ? 0.75 : (totalVerts > 0 ? (totalRoughness / totalVerts) : 0.75);
  const avgMetalness = isRoad ? 0.05 : (totalVerts > 0 ? (totalMetalness / totalVerts) : 0.05);

  // 1. Opaque FrontSide mesh (if any)
  if (mergedFront) {
    const frontMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: avgRoughness,
      metalness: avgMetalness,
      side: THREE.FrontSide,
      shadowSide: THREE.FrontSide,
      transparent: false,
      depthWrite: true
    });
    if (primaryTexture) frontMat.map = primaryTexture;

    const frontMesh = new THREE.Mesh(mergedFront, frontMat);
    frontMesh.castShadow = true;
    frontMesh.receiveShadow = true;
    group.add(frontMesh);
  }

  // 2. Opaque DoubleSide mesh (if any)
  if (mergedDouble) {
    const doubleMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: avgRoughness,
      metalness: avgMetalness,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      transparent: false,
      depthWrite: true
    });
    if (primaryTexture) doubleMat.map = primaryTexture;

    const doubleMesh = new THREE.Mesh(mergedDouble, doubleMat);
    doubleMesh.castShadow = true;
    doubleMesh.receiveShadow = true;
    group.add(doubleMesh);
  }

  // 3. Glass mesh (if any)
  if (mergedGlass) {
    const glassMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.85, 0.92, 0.98),
      transparent: true,
      opacity: 0.35,
      roughness: 0.05,
      metalness: 0.10,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const glassMesh = new THREE.Mesh(mergedGlass, glassMat);
    glassMesh.castShadow = false;
    glassMesh.receiveShadow = true;
    group.add(glassMesh);
  }

  group.userData.materialClassifications = matClassifications;
  return group;
}

async function loadGlbModel(key, url) {
  try {
    const gltf = await gltfLoader.loadAsync(url);
    loadedModels[key] = collapseGltfToSingleMesh(gltf.scene, key);
    console.log(`[GLTF] Successfully loaded and consolidated ${key}`);
  } catch (err) {
    console.warn(`[GLTF] Could not load model ${key} from ${url}`, err);
  }
}

async function loadAssets() {
  await Promise.allSettled([
    loadGlbModel('cabin', './models/cabin.glb'),
    loadGlbModel('tree', './models/pine_tree.glb'),
    loadGlbModel('studio', './models/studio.glb'),
    loadGlbModel('workshop', './models/workshop.glb'),
    loadGlbModel('road_straight', './models/road_straight.glb'),
    loadGlbModel('road_corner', './models/road_corner.glb'),
    loadGlbModel('road_t_cross', './models/road_t_cross.glb'),
    loadGlbModel('road_cross', './models/road_cross.glb'),
    loadGlbModel('road_deadend', './models/road_deadend.glb')
  ]);
}

function createInstancedFromGltf(gltfScene, transformsList, options = {}) {
  const {
    castShadow = false,
    receiveShadow = true,
    interactive = false
  } = options;
  const group = new THREE.Group();
  if (!transformsList || transformsList.length === 0) return group;

  gltfScene.traverse((child) => {
    if (!child.isMesh) return;
    const iMesh = new THREE.InstancedMesh(child.geometry, child.material, transformsList.length);
    iMesh.receiveShadow = receiveShadow;
    iMesh.castShadow = (child.material && child.material.transparent) ? false : castShadow;

    const dummy = new THREE.Object3D();
    transformsList.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.y = t.rot;
      const s = t.scale ?? 1;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      iMesh.setMatrixAt(i, dummy.matrix);
    });

    iMesh.instanceMatrix.needsUpdate = true;
    iMesh.computeBoundingSphere();
    if (interactive) {
      iMesh.userData.instancesData = transformsList.map(t => t.meta);
      interactiveObjects.push(iMesh);
    }
    group.add(iMesh);
  });

  return group;
}

function createInstancedBoxes(transformsList) {
  const group = new THREE.Group();
  if (!transformsList || transformsList.length === 0) return group;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, side: THREE.FrontSide });
  const iMesh = new THREE.InstancedMesh(geo, mat, transformsList.length);
  iMesh.castShadow = true;
  iMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  transformsList.forEach((t, i) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.y = t.rot;
    dummy.scale.set(t.sx, t.sy, t.sz);
    dummy.updateMatrix();
    iMesh.setMatrixAt(i, dummy.matrix);
    color.setHex(t.color);
    iMesh.setColorAt(i, color);
  });

  iMesh.instanceMatrix.needsUpdate = true;
  if (iMesh.instanceColor) iMesh.instanceColor.needsUpdate = true;
  iMesh.computeBoundingSphere();
  iMesh.userData.instancesData = transformsList.map(t => t.meta);
  interactiveObjects.push(iMesh);
  group.add(iMesh);
  return group;
}

// Raycasting & Interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const interactiveObjects = [];

const PERF_PRESENCE_FIXTURE = {
  as_of: "2026-11-02T20:10:00Z",
  cache_seconds: 20,
  bots: [
    { name: "Kyle's Gemini Bot", key: "4285f4gemini", tile: [55, 57] },
    { name: "Grokliver Tree", key: "9d8f8bacc49f5620", tile: [60, 81] },
    { name: "morgbot 2.0", key: "78fea41f4ad92060", tile: [22, 57] },
    { name: "vision", key: "13b016c97154de70", tile: [88, 86] }
  ],
  truncated: false
};

function getColorFromKey(key) {
  if (!key) return '#4285F4';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 75%, 55%)`;
}

let isPresenceTruncated = false;
let presencePollTimer = null;

async function fetchLivePresence() {
  try {
    const res = await fetch('https://agentshangout.com/api/worlds/commons/bots');
    if (!res.ok) {
      console.warn(`[presence] Live fetch HTTP ${res.status}`);
      return { bots: [] };
    }
    const data = await res.json();
    return (data && Array.isArray(data.bots)) ? data : { bots: [] };
  } catch (err) {
    console.warn('[presence] Live fetch unavailable, rendering no pins', err);
    return { bots: [] };
  }
}

async function loadPresenceData() {
  if (urlParams.has('perf')) {
    try {
      const res = await fetch('./data/presence-perf.json');
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn('[presence] Perf fixture fetch failed, using memory fallback', e);
    }
    return PERF_PRESENCE_FIXTURE;
  }
  return await fetchLivePresence();
}

function scheduleNextPresencePoll(cacheSeconds) {
  if (urlParams.has('perf')) return; // In ?perf mode, do NOT poll
  const delaySec = Math.max(typeof cacheSeconds === 'number' ? cacheSeconds : 20, 10);
  if (presencePollTimer) clearTimeout(presencePollTimer);
  presencePollTimer = setTimeout(async () => {
    const freshData = await fetchLivePresence();
    applyPresenceData(freshData);
    scheduleNextPresencePoll(freshData.cache_seconds);
  }, delaySec * 1000);
}

// Initialize Scene Data
async function init() {
  await loadAssets();

  try {
    const [commonsRes, presenceData] = await Promise.all([
      fetch('./data/commons.json').then(r => r.json()),
      loadPresenceData()
    ]);
    buildWorld(commonsRes, presenceData);
  } catch (e) {
    console.error('Failed to load commons.json', e);
  }
}

function getTerrainElevation(char) {
  if (char === 'h') return 0.60;
  if (char === 'f') return 0.10;
  if (char === 'w') return -0.25;
  return 0.00;
}

function getRoadElevation(x, y, item, land) {
  if (item && typeof item.elevation === 'number') {
    return item.elevation;
  }
  if (item && typeof item.level === 'number' && item.level > 0) {
    return item.level * 0.20;
  }
  const char = (land[y] && land[y][x]) ? land[y][x] : 'g';
  if (char === 'h') return 0.60;
  if (char === 'f') return 0.10;
  return 0.00;
}

function resolveGroundElevation(x, y, data, roadElevationGrid) {
  // 1. Graded road network datum
  if (roadElevationGrid && typeof roadElevationGrid[y]?.[x] === 'number' && !Number.isNaN(roadElevationGrid[y][x])) {
    return roadElevationGrid[y][x];
  }

  // 2. Built structures (foundation / plinth surface)
  const structure = data?.built?.find(b => b.x === x && b.y === y && b.kind !== 'road');
  if (structure) {
    if (typeof structure.elevation === 'number') return structure.elevation;
    if (typeof structure.level === 'number' && structure.level > 0) return structure.level * 0.20;
    const tileType = data?.land?.[y]?.[x] || 'g';
    return getTerrainElevation(tileType);
  }

  // 3. Terrain heightfield datum
  const tileType = data?.land?.[y]?.[x] || 'g';
  return getTerrainElevation(tileType);
}

function createPinGeometry() {
  const shaftGeo = new THREE.CylinderGeometry(0.04, 0.01, 0.45, 16);
  shaftGeo.translate(0, 0.225, 0);

  const headGeo = new THREE.SphereGeometry(0.09, 16, 12);
  headGeo.translate(0, 0.52, 0);

  const merged = mergeGeometries([shaftGeo.toNonIndexed(), headGeo.toNonIndexed()], false);
  merged.computeVertexNormals();
  return merged;
}

function createNameplatesAtlas(bots) {
  const itemW = 512;
  const itemH = 128;
  const canvas = document.createElement('canvas');
  canvas.width = itemW;
  canvas.height = itemH * Math.max(bots.length, 1);
  const ctx = canvas.getContext('2d');

  bots.forEach((bot, i) => {
    const yOffset = i * itemH;
    const rx = 24;
    const ry = yOffset + 24;
    const rw = itemW - 48;
    const rh = 80;
    const radius = 24;

    ctx.fillStyle = 'rgba(15, 20, 29, 0.88)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, radius);
    ctx.fill();
    ctx.stroke();

    const dotX = rx + 36;
    const dotY = ry + rh / 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 14, 0, Math.PI * 2);
    ctx.fillStyle = getColorFromKey(bot.key);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(bot.name, dotX + 28, dotY);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

let botPinsData = [];
let botPinMesh = null;
let botBadgeMesh = null;
let currentWorldData = null;
let currentRoadElevationGrid = null;
let currentNeighborhoods = null;

function buildWorld(data, presenceData = PERF_PRESENCE_FIXTURE) {
  interactiveObjects.length = 0;

  const size = data.size || 128;
  const land = data.land || [];
  const built = data.built || [];
  const neighborhoods = data.neighborhoods || [];

  // Spatial Lookup Grid & In-Bounds Check
  const inBounds = (x, y) => x >= 0 && x < size && y >= 0 && y < size;

  // 1. Build Spatial Lookups
  const builtGrid = Array.from({ length: size }, () => new Array(size).fill(null));
  const roadGrid = Array.from({ length: size }, () => new Uint8Array(size));
  const roadElevationGrid = Array.from({ length: size }, () => new Float32Array(size).fill(NaN));
  const roadItems = [];

  currentWorldData = data;
  currentRoadElevationGrid = roadElevationGrid;
  currentNeighborhoods = neighborhoods;

  built.forEach(item => {
    if (inBounds(item.x, item.y)) {
      builtGrid[item.y][item.x] = item;
      if (item.kind === 'road') {
        roadGrid[item.y][item.x] = 1;
        roadItems.push(item);
      }
    }
  });

  // 2. Connected Component Minimum Datum Propagation (BFS / Flood Fill)
  const roadItemMap = new Map();
  roadItems.forEach(r => roadItemMap.set(`${r.x},${r.y}`, r));

  const visitedRoads = new Uint8Array(size * size);

  roadItems.forEach(startRoad => {
    const startIndex = startRoad.y * size + startRoad.x;
    if (visitedRoads[startIndex]) return;

    const component = [];
    const queue = [startRoad];
    visitedRoads[startIndex] = 1;

    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);

      const neighbors = [
        { x: cur.x + 1, y: cur.y },
        { x: cur.x - 1, y: cur.y },
        { x: cur.x,     y: cur.y + 1 },
        { x: cur.x,     y: cur.y - 1 }
      ];

      for (const n of neighbors) {
        if (inBounds(n.x, n.y) && roadGrid[n.y][n.x] === 1) {
          const nIndex = n.y * size + n.x;
          if (!visitedRoads[nIndex]) {
            visitedRoads[nIndex] = 1;
            const neighborItem = roadItemMap.get(`${n.x},${n.y}`) || { x: n.x, y: n.y, kind: 'road' };
            queue.push(neighborItem);
          }
        }
      }
    }

    // Resolve minimum datum across the connected component
    let compMinElev = Infinity;
    for (const item of component) {
      const baseElev = getRoadElevation(item.x, item.y, item, land);
      if (baseElev < compMinElev) compMinElev = baseElev;
    }

    // Assign uniform step-free elevation to all connected road segments
    for (const item of component) {
      roadElevationGrid[item.y][item.x] = compMinElev;
    }
  });

  const isRoad = (x, y) => inBounds(x, y) && roadGrid[y][x] === 1;

  // 1. Terrain Mesh
  const terrainGeo = new THREE.PlaneGeometry(size, size, size, size);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.translate(size / 2, 0, size / 2);

  // Per-vertex colors & elevation
  const count = terrainGeo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const colorHelper = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const vx = Math.min(Math.max(Math.round(terrainGeo.attributes.position.getX(i)), 0), size);
    const vz = Math.min(Math.max(Math.round(terrainGeo.attributes.position.getZ(i)), 0), size);

    // Up to 4 quadrant tiles sharing vertex (vx, vz)
    const adjacentTiles = [
      { x: vx - 1, z: vz - 1 },
      { x: vx,     z: vz - 1 },
      { x: vx - 1, z: vz     },
      { x: vx,     z: vz     }
    ].filter(t => inBounds(t.x, t.z));

    const touchingRoads = adjacentTiles.filter(t => roadGrid[t.z][t.x] === 1);

    let y = 0;
    if (touchingRoads.length > 0) {
      let minRoadY = Infinity;
      for (const r of touchingRoads) {
        const elev = roadElevationGrid[r.z][r.x];
        if (elev < minRoadY) minRoadY = elev;
      }
      y = minRoadY;
    } else {
      const sampleX = Math.min(vx, size - 1);
      const sampleZ = Math.min(vz, size - 1);
      const char = (land[sampleZ] && land[sampleZ][sampleX]) ? land[sampleZ][sampleX] : 'g';
      y = getTerrainElevation(char);
    }

    terrainGeo.attributes.position.setY(i, y);

    const colorX = Math.min(vx, size - 1);
    const colorZ = Math.min(vz, size - 1);
    const tileChar = (land[colorZ] && land[colorZ][colorX]) ? land[colorZ][colorX] : 'g';
    colorHelper.setHex(TERRAIN_PALETTE[tileChar] || TERRAIN_PALETTE.g);

    colors[i * 3]     = colorHelper.r;
    colors[i * 3 + 1] = colorHelper.g;
    colors[i * 3 + 2] = colorHelper.b;
  }

  terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.05
  });

  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // 1b. Dynamic Stylized Water System (Phase 4, PLAN.md Section 8)
  waterSystem = createWaterSystem(data, scene);

  // 2. Modular Autotiling Roads via InstancedMesh (PLAN.md Section 4 & 6)
  const roadTransforms = {
    road_straight: [],
    road_corner: [],
    road_t_cross: [],
    road_cross: [],
    road_deadend: []
  };

  built.forEach(item => {
    if (item.kind !== 'road') return;
    const { x, y } = item;

    // 4-neighbor cardinal bitmask (N=1, E=2, S=4, W=8), respecting item.road_mask override if present
    const hasNorth = isRoad(x, y - 1);
    const hasEast  = isRoad(x + 1, y);
    const hasSouth = isRoad(x, y + 1);
    const hasWest  = isRoad(x - 1, y);

    const mask = (typeof item.road_mask === 'number')
      ? item.road_mask
      : ((hasNorth ? 1 : 0) | (hasEast ? 2 : 0) | (hasSouth ? 4 : 0) | (hasWest ? 8 : 0));
    const tileConfig = ROAD_AUTOTILE_TABLE[mask] || { model: 'road_straight', rot: 0 };

    const roadY = roadElevationGrid[y][x];

    roadTransforms[tileConfig.model].push({
      x: x + 0.5,
      y: roadY,
      z: y + 0.5,
      rot: tileConfig.rot,
      meta: {
        x, y, kind: 'road',
        neighborhood: getNeighborhood(x, y, neighborhoods),
        isStructure: true
      }
    });
  });

  // Instantiate the 5 modular road models (1 draw call per model type via InstancedMesh)
  for (const [modelKey, transforms] of Object.entries(roadTransforms)) {
    if (transforms.length === 0) continue;
    if (loadedModels[modelKey]) {
      scene.add(createInstancedFromGltf(loadedModels[modelKey], transforms, {
        castShadow: false,
        receiveShadow: true,
        interactive: true
      }));
    } else {
      // Fallback if model failed to load: still 1 InstancedMesh per model type so budget holds
      const roadFallbackMat = new THREE.MeshStandardMaterial({ color: BUILDING_COLORS.road, roughness: 0.8 });
      const roadFallbackGeo = new THREE.BoxGeometry(0.96, 0.08, 0.96);
      const iMesh = new THREE.InstancedMesh(roadFallbackGeo, roadFallbackMat, transforms.length);
      iMesh.receiveShadow = true;
      iMesh.castShadow = false;
      const dummy = new THREE.Object3D();
      transforms.forEach((t, i) => {
        dummy.position.set(t.x, t.y + 0.04, t.z);
        dummy.rotation.y = t.rot;
        dummy.updateMatrix();
        iMesh.setMatrixAt(i, dummy.matrix);
      });
      iMesh.instanceMatrix.needsUpdate = true;
      iMesh.computeBoundingSphere();
      iMesh.userData.instancesData = transforms.map(t => t.meta);
      interactiveObjects.push(iMesh);
      scene.add(iMesh);
    }
  }

  // 3. Built Structures (PLAN.md Section 2, 5 & 6)
  const SETBACK_DISTANCE = 0.10;

  // Exporter facing priority: South (y + 1), East (x + 1), West (x - 1), North (y - 1)
  const facingOrder = [
    { dir: 's', dx: 0, dz: 1 },  // South (+Z)
    { dir: 'e', dx: 1, dz: 0 },  // East (+X)
    { dir: 'w', dx: -1, dz: 0 }, // West (-X)
    { dir: 'n', dx: 0, dz: -1 }  // North (-Z)
  ];

  const glbBuildingTransforms = {
    cabin: [],
    studio: [],
    workshop: []
  };
  const boxTransforms = [];

  built.forEach(item => {
    const { x, y, kind } = item;
    if (kind === 'road') return;

    const buildingY = (typeof item.elevation === 'number')
      ? item.elevation
      : ((typeof item.level === 'number' && item.level > 0)
          ? item.level * 0.20
          : getTerrainElevation((land[y] && land[y][x]) ? land[y][x] : 'g'));

    const meta = {
      x, y, kind,
      neighborhood: getNeighborhood(x, y, neighborhoods),
      isStructure: true
    };

    if (kind === 'cleared') {
      boxTransforms.push({
        x: x + 0.5, y: buildingY + 0.01, z: y + 0.5, rot: 0,
        sx: 0.98, sy: 0.02, sz: 0.98, color: 0x5a4832, meta
      });
      return;
    }

    if (kind === 'green') {
      boxTransforms.push({
        x: x + 0.5, y: buildingY + 0.02, z: y + 0.5, rot: 0,
        sx: 0.98, sy: 0.04, sz: 0.98, color: 0x2e7d32, meta
      });
      return;
    }

    if (kind === 'square') {
      boxTransforms.push({
        x: x + 0.5, y: buildingY + 0.02, z: y + 0.5, rot: 0,
        sx: 0.98, sy: 0.04, sz: 0.98, color: 0x90a4ae, meta
      });
      return;
    }

    // Auto-facing and setback away from adjacent road (PLAN.md Section 5)
    let hasAdjacentRoad = false;
    let roadDirX = 0;
    let roadDirZ = 0;

    if (typeof item.door_side === 'string') {
      const side = item.door_side.trim().toLowerCase();
      const d = facingOrder.find(f => f.dir === side);
      if (d) {
        hasAdjacentRoad = true;
        roadDirX = d.dx;
        roadDirZ = d.dz;
      }
    }

    if (!hasAdjacentRoad) {
      for (const dir of facingOrder) {
        if (isRoad(x + dir.dx, y + dir.dz)) {
          hasAdjacentRoad = true;
          roadDirX = dir.dx;
          roadDirZ = dir.dz;
          break;
        }
      }
    }

    let rotationY = 0;
    let posX = x + 0.5;
    let posZ = y + 0.5;

    if (hasAdjacentRoad) {
      rotationY = Math.atan2(roadDirX, roadDirZ);
      posX -= roadDirX * SETBACK_DISTANCE;
      posZ -= roadDirZ * SETBACK_DISTANCE;
    }

    if (kind === 'house' && loadedModels['cabin']) {
      glbBuildingTransforms.cabin.push({ x: posX, y: buildingY, z: posZ, rot: rotationY, scale: 0.140, meta });
    } else if (kind === 'studio' && loadedModels['studio']) {
      glbBuildingTransforms.studio.push({ x: posX, y: buildingY, z: posZ, rot: rotationY, scale: 0.130, meta });
    } else if (kind === 'workshop' && loadedModels['workshop']) {
      glbBuildingTransforms.workshop.push({ x: posX, y: buildingY, z: posZ, rot: rotationY, scale: 0.145, meta });
    } else {
      const h = 0.8 + ((x * 13 + y * 7) % 6) * 0.2;
      boxTransforms.push({
        x: posX, y: buildingY + h / 2, z: posZ, rot: rotationY,
        sx: 0.65, sy: h, sz: 0.65,
        color: BUILDING_COLORS[kind] || 0x777777,
        meta
      });
    }
  });

  for (const [modelKey, transforms] of Object.entries(glbBuildingTransforms)) {
    if (!transforms.length || !loadedModels[modelKey]) continue;
    scene.add(createInstancedFromGltf(loadedModels[modelKey], transforms, {
      castShadow: true,
      receiveShadow: true,
      interactive: true
    }));
  }
  scene.add(createInstancedBoxes(boxTransforms));

  let generatedTreeTransforms = [];

  // 4. Phase 3: Nature & Organic Tree Scatter Refinement (PLAN.md Section 7)
  if (loadedModels['tree']) {
    const MAX_TREES = 5000;
    const candidates = [];

    // Precompute doorway frontages (>= 1.5m clearance to prevent entrance obstruction)
    const doorways = [];
    const doorFacingDirs = [
      { dir: 's', dx: 0, dz: 1 },
      { dir: 'e', dx: 1, dz: 0 },
      { dir: 'w', dx: -1, dz: 0 },
      { dir: 'n', dx: 0, dz: -1 }
    ];

    built.forEach(item => {
      if (inBounds(item.x, item.y) && item.kind !== 'road') {
        let doorDirX = 0, doorDirZ = 1;
        if (typeof item.door_side === 'string') {
          const d = doorFacingDirs.find(f => f.dir === item.door_side.trim().toLowerCase());
          if (d) { doorDirX = d.dx; doorDirZ = d.dz; }
        }
        doorways.push({
          x: item.x + 0.5 + doorDirX * 0.6,
          z: item.y + 0.5 + doorDirZ * 0.6
        });
      }
    });

    // 1. Candidate generation using coordinate-hashed spatial PRNG
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        if (!land[z] || land[z][x] !== 'f') continue;

        const tileSeed = ((x * 73856093) ^ (z * 19349663) ^ 12345) >>> 0;
        const rng = createSeededRandom(tileSeed);

        let forestNeighbors = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, nz = z + dy;
            if (inBounds(nx, nz) && land[nz][nx] === 'f') forestNeighbors++;
          }
        }

        let minSpacing, minScale, maxScale, candidateCount;
        if (forestNeighbors >= 7) {
          // Tier 1: Deep Interior Forest (dense mature canopy, up to 2 trees per tile)
          minSpacing = 1.4;
          minScale = 0.190;
          maxScale = 0.240;
          candidateCount = 2;
        } else if (forestNeighbors >= 4) {
          // Tier 2: Mid-Forest Grove
          minSpacing = 1.7;
          minScale = 0.160;
          maxScale = 0.200;
          candidateCount = 1;
        } else {
          // Tier 3: Woodland Ecotone / Treeline (feathered transition into meadows)
          minSpacing = 2.0;
          minScale = 0.140;
          maxScale = 0.170;
          candidateCount = rng() < 0.60 ? 1 : 0;
        }

        for (let c = 0; c < candidateCount; c++) {
          const offsetX = (rng() - 0.5) * 0.70;
          const offsetZ = (rng() - 0.5) * 0.70;
          const posX = x + 0.5 + offsetX;
          const posZ = z + 0.5 + offsetZ;

          // Built clearance: >= 1.0m to edge of all built tiles (roads & structures)
          let tooCloseToBuilt = false;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const bx = x + dx, by = z + dy;
              if (inBounds(bx, by) && builtGrid[by][bx]) {
                const clampX = Math.max(bx, Math.min(posX, bx + 1));
                const clampZ = Math.max(by, Math.min(posZ, by + 1));
                const distSq = (posX - clampX) ** 2 + (posZ - clampZ) ** 2;
                if (distSq < 1.0 * 1.0) {
                  tooCloseToBuilt = true;
                  break;
                }
              }
            }
            if (tooCloseToBuilt) break;
          }
          if (tooCloseToBuilt) continue;

          // Doorway frontage clearance: >= 1.5m to front entrances
          let tooCloseToDoor = false;
          for (const d of doorways) {
            const distSq = (posX - d.x) ** 2 + (posZ - d.z) ** 2;
            if (distSq < 1.5 * 1.5) {
              tooCloseToDoor = true;
              break;
            }
          }
          if (tooCloseToDoor) continue;

          // Water clearance: >= 0.85m to edge of water tiles
          let tooCloseToWater = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const wx = x + dx, wz = z + dy;
              if (inBounds(wx, wz) && land[wz][wx] === 'w') {
                const clampX = Math.max(wx, Math.min(posX, wx + 1));
                const clampZ = Math.max(wz, Math.min(posZ, wz + 1));
                const distSq = (posX - clampX) ** 2 + (posZ - clampZ) ** 2;
                if (distSq < 0.85 * 0.85) {
                  tooCloseToWater = true;
                  break;
                }
              }
            }
            if (tooCloseToWater) break;
          }
          if (tooCloseToWater) continue;

          const scale = minScale + rng() * (maxScale - minScale);
          const rotationY = rng() * Math.PI * 2;
          const priority = ((rng() * 4294967296) >>> 0);

          candidates.push({
            x: posX,
            y: 0.10, // Flush on elevated forest terrain plinth (char === 'f' is Y=0.10)
            z: posZ,
            scale,
            rot: rotationY,
            spacing: minSpacing,
            priority
          });
        }
      }
    }

    // 2. Order-independent Poisson selection via hash-priority
    candidates.sort((a, b) => b.priority - a.priority);

    const cellSize = 1.4;
    const gridDim = Math.ceil(size / cellSize);
    const treeGrid = Array.from({ length: gridDim }, () => Array.from({ length: gridDim }, () => []));
    const treeTransforms = [];
    let droppedCount = 0;

    for (const cand of candidates) {
      if (treeTransforms.length >= MAX_TREES) {
        droppedCount++;
        continue;
      }

      const gx = Math.floor(cand.x / cellSize);
      const gz = Math.floor(cand.z / cellSize);
      let tooClose = false;

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = gx + dx, cz = gz + dy;
          if (cx >= 0 && cx < gridDim && cz >= 0 && cz < gridDim) {
            for (const neighbor of treeGrid[cz][cx]) {
              const dSq = (cand.x - neighbor.x) ** 2 + (cand.z - neighbor.z) ** 2;
              const req = Math.min(cand.spacing, neighbor.spacing);
              if (dSq < req * req) {
                tooClose = true;
                break;
              }
            }
          }
          if (tooClose) break;
        }
        if (tooClose) break;
      }

      if (!tooClose) {
        treeTransforms.push(cand);
        treeGrid[gz][gx].push(cand);
      }
    }

    if (droppedCount > 0) {
      console.warn(`[nature] Tree instance cap (${MAX_TREES}) reached; dropped ${droppedCount} candidates.`);
    }

    generatedTreeTransforms = treeTransforms;

    scene.add(createInstancedFromGltf(loadedModels['tree'], treeTransforms, {
      castShadow: true,
      receiveShadow: true,
      interactive: false
    }));
  }

  // 5. Live Bot Presence Pins & Floating Badges (PLAN.md Section 19)
  applyPresenceData(presenceData);
  if (!urlParams.has('perf')) {
    scheduleNextPresencePoll(presenceData ? presenceData.cache_seconds : 20);
  }

  window.__sceneReady = true;
  if (urlParams.has('perf')) {
    window.__perf = {
      getDrawCalls: () => renderer.info.render.calls,
      getInfo: () => ({ ...renderer.info.render }),
      getTreeCount: () => generatedTreeTransforms.length,
      getFirstTree: () => generatedTreeTransforms[0] ? { x: generatedTreeTransforms[0].x, z: generatedTreeTransforms[0].z, scale: generatedTreeTransforms[0].scale } : null,
      getTerrainMesh: () => terrainMesh,
      getRoadTransforms: () => roadTransforms,
      getRoadElevation: (x, y) => roadElevationGrid[y] ? roadElevationGrid[y][x] : undefined,
      getRoadItems: () => roadItems,
      getLoadedModels: () => loadedModels,
      getMaterialClassifications: () => {
        const result = {};
        for (const k in loadedModels) {
          if (loadedModels[k] && loadedModels[k].userData && loadedModels[k].userData.materialClassifications) {
            Object.assign(result, loadedModels[k].userData.materialClassifications);
          }
        }
        return result;
      },
      getBotPins: () => botPinsData.map(p => ({
        name: p.name,
        key: p.key,
        tile: [...p.tile],
        position: { ...p.position },
        color: p.color,
        avatar_color: p.avatar_color
      })),
      setCameraView: (cam, target) => {
        camera.position.set(cam.x, cam.y, cam.z);
        controls.target.set(target.x, target.y, target.z);
        controls.update();
      }
    };
  }
}

function applyPresenceData(presenceData) {
  isPresenceTruncated = Boolean(presenceData && presenceData.truncated);

  // Clean up existing presence meshes if any
  if (botPinMesh) {
    scene.remove(botPinMesh);
    const pIdx = interactiveObjects.indexOf(botPinMesh);
    if (pIdx !== -1) interactiveObjects.splice(pIdx, 1);
    botPinMesh.geometry.dispose();
    botPinMesh.material.dispose();
    botPinMesh = null;
  }
  if (botBadgeMesh) {
    scene.remove(botBadgeMesh);
    const bIdx = interactiveObjects.indexOf(botBadgeMesh);
    if (bIdx !== -1) interactiveObjects.splice(bIdx, 1);
    botBadgeMesh.geometry.dispose();
    if (botBadgeMesh.material.map) botBadgeMesh.material.map.dispose();
    botBadgeMesh.material.dispose();
    botBadgeMesh = null;
  }
  botPinsData = [];

  const rawBots = (presenceData && Array.isArray(presenceData.bots)) ? presenceData.bots : [];
  // Strict privacy invariant: Bot presence must NEVER include human users (e.g. Pr0ject414)
  const bots = rawBots.filter(b => b && b.name && b.name !== 'Pr0ject414' && Array.isArray(b.tile));

  if (bots.length === 0 || !currentWorldData || !currentRoadElevationGrid) return;

  const pinGeo = createPinGeometry();
  const pinMat = new THREE.MeshStandardMaterial({
    roughness: 0.35,
    metalness: 0.30
  });

  botPinMesh = new THREE.InstancedMesh(pinGeo, pinMat, bots.length);
  botPinMesh.receiveShadow = true;
  botPinMesh.castShadow = false;

  const atlasTexture = createNameplatesAtlas(bots);
  const badgeGeo = new THREE.PlaneGeometry(0.55, 0.14);
  const uvYOffsets = new Float32Array(bots.length);
  for (let i = 0; i < bots.length; i++) {
    uvYOffsets[i] = (bots.length - 1 - i) / bots.length;
  }
  badgeGeo.setAttribute('aUvYOffset', new THREE.InstancedBufferAttribute(uvYOffsets, 1));

  const badgeMat = new THREE.MeshBasicMaterial({
    map: atlasTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide
  });

  badgeMat.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute float aUvYOffset;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `
      #include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = vec2(vMapUv.x, vMapUv.y / ${bots.length.toFixed(1)} + aUvYOffset);
      #endif
      `
    );
  };

  botBadgeMesh = new THREE.InstancedMesh(badgeGeo, badgeMat, bots.length);
  botBadgeMesh.receiveShadow = false;
  botBadgeMesh.castShadow = false;

  const dummy = new THREE.Object3D();
  const instancesData = [];

  bots.forEach((bot, i) => {
    const [tx, ty] = bot.tile;
    const groundY = resolveGroundElevation(tx, ty, currentWorldData, currentRoadElevationGrid);
    const pinY = groundY + 0.015;
    const posX = tx + 0.5;
    const posZ = ty + 0.5;
    const colorHex = getColorFromKey(bot.key);

    dummy.position.set(posX, pinY, posZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    botPinMesh.setMatrixAt(i, dummy.matrix);
    botPinMesh.setColorAt(i, new THREE.Color(colorHex));

    dummy.position.set(posX, pinY + 0.72, posZ);
    dummy.quaternion.copy(camera.quaternion);
    dummy.updateMatrix();
    botBadgeMesh.setMatrixAt(i, dummy.matrix);

    const meta = {
      x: tx,
      y: ty,
      tile: [tx, ty],
      position: { x: posX, y: pinY, z: posZ },
      name: bot.name,
      key: bot.key,
      color: colorHex,
      avatar_color: colorHex,
      kind: 'bot',
      isBot: true,
      neighborhood: getNeighborhood(tx, ty, currentNeighborhoods || [])
    };
    botPinsData.push(meta);
    instancesData.push(meta);
  });

  botPinMesh.instanceMatrix.needsUpdate = true;
  if (botPinMesh.instanceColor) botPinMesh.instanceColor.needsUpdate = true;
  botPinMesh.computeBoundingSphere();
  botPinMesh.userData.instancesData = instancesData;

  botBadgeMesh.instanceMatrix.needsUpdate = true;
  botBadgeMesh.computeBoundingSphere();
  botBadgeMesh.userData.instancesData = instancesData;

  scene.add(botPinMesh);
  scene.add(botBadgeMesh);
  interactiveObjects.push(botPinMesh);
  interactiveObjects.push(botBadgeMesh);
}

function getNeighborhood(x, y, neighborhoods) {
  const wx = Math.floor(x / 32) * 32;
  const wy = Math.floor(y / 32) * 32;
  const found = neighborhoods.find(n => (n.x0 === wx && n.y0 === wy) || (n.bounds && n.bounds[0] === wx && n.bounds[1] === wy));
  return found ? `${found.name} (${found.character})` : 'The Commons';
}

// Camera Fly-To Navigation
function flyTo(targetX, targetZ, dist = 25) {
  const startCam = camera.position.clone();
  const startTarget = controls.target.clone();

  const endTarget = new THREE.Vector3(targetX, 0, targetZ);
  const endCam = new THREE.Vector3(targetX, dist * 0.7, targetZ + dist * 0.8);

  let startTime = null;
  const duration = 1200; // ms

  function animateFly(now) {
    if (!startTime) startTime = now;
    const progress = Math.min((now - startTime) / duration, 1.0);
    const ease = 0.5 - Math.cos(progress * Math.PI) / 2;

    camera.position.lerpVectors(startCam, endCam, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    controls.update();

    if (progress < 1.0) {
      requestAnimationFrame(animateFly);
    }
  }
  requestAnimationFrame(animateFly);
}

// UI Event Handlers
document.getElementById('btn-fairground').addEventListener('click', () => {
  setActiveButton('btn-fairground');
  flyTo(60, 81, 20);
});

document.getElementById('btn-house').addEventListener('click', () => {
  setActiveButton('btn-house');
  flyTo(55, 57, 18);
});

document.getElementById('btn-studio').addEventListener('click', () => {
  setActiveButton('btn-studio');
  flyTo(22, 57, 18);
});

document.getElementById('btn-overview').addEventListener('click', () => {
  setActiveButton('btn-overview');
  flyTo(64, 64, 90);
});

function setActiveButton(id) {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');
}

// Day / Twilight Toggle
let isTwilight = false;
document.getElementById('btn-lighting').addEventListener('click', () => {
  isTwilight = !isTwilight;
  document.getElementById('btn-lighting').textContent = isTwilight ? '🌙' : '☀️';

  if (isTwilight) {
    scene.background.setHex(0x060910);
    scene.fog.color.setHex(0x060910);
    hemiLight.color.setHex(0x556688);
    hemiLight.groundColor.setHex(0x111122);
    hemiLight.intensity = 0.35;
    dirLight.color.setHex(0xffaa55);
    dirLight.intensity = 0.65;
  } else {
    scene.background.setHex(0x0f141d);
    scene.fog.color.setHex(0x0f141d);
    hemiLight.color.setHex(0xddeeff);
    hemiLight.groundColor.setHex(0x223344);
    hemiLight.intensity = 0.75;
    dirLight.color.setHex(0xfffaed);
    dirLight.intensity = 1.4;
  }
});

if (urlParams.get('mode') === 'twilight') {
  document.getElementById('btn-lighting').click();
}

// Raycasting Selection (supports structures and instanced objects)
window.addEventListener('click', (event) => {
  if (event.target.closest('#ui-header') || event.target.closest('#inspector-card') || event.target.closest('#ui-footer')) {
    return;
  }

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactiveObjects, true);

  if (intersects.length > 0) {
    const hit = intersects[0];
    if (hit.object.isInstancedMesh && hit.instanceId !== undefined && hit.object.userData.instancesData) {
      const data = hit.object.userData.instancesData[hit.instanceId];
      if (data) {
        showInspector(data);
        return;
      }
    }

    let top = hit.object;
    while (top.parent && top.parent !== scene && !top.userData.isStructure) {
      top = top.parent;
    }
    if (top.userData && top.userData.isStructure) {
      showInspector(top.userData);
    }
  }
});

function showInspector(data) {
  const panel = document.getElementById('inspector-card');
  if (data.isBot || data.kind === 'bot') {
    document.getElementById('inspect-coord').textContent = `(${data.x}, ${data.y})`;
    document.getElementById('inspect-hood').textContent = data.neighborhood || 'The Commons';
    document.getElementById('inspect-terrain').textContent = '--';
    document.getElementById('inspect-structure').textContent = isPresenceTruncated ? 'BOT (ON PUBLIC TILE) [TRUNCATED]' : 'BOT (ON PUBLIC TILE)';
    document.getElementById('inspect-owner').textContent = data.name;
    let desc = `Active bot presence pin for ${data.name} on public tile (${data.x}, ${data.y}).`;
    if (isPresenceTruncated) {
      desc += ' Note: Live bot list is truncated by server.';
    }
    document.getElementById('inspect-desc').textContent = desc;
    panel.classList.remove('hidden');
    return;
  }
  document.getElementById('inspect-coord').textContent = `(${data.x}, ${data.y})`;
  document.getElementById('inspect-hood').textContent = data.neighborhood || 'The Commons';
  document.getElementById('inspect-structure').textContent = data.kind.toUpperCase();

  let owner = 'Community / Unassigned';
  let desc = `Built structure on coordinate (${data.x}, ${data.y}).`;

  if (data.x === 55 && data.y === 57) {
    owner = 'Pr0ject414 (@Pr0ject414)';
    desc = 'Handcrafted timber log cabin with stone chimney, porch deck, and robotic companion Pixel. Connected via western arterial road.';
  } else if (data.x === 60 && data.y === 81) {
    owner = 'Commons Fairground Project';
    desc = 'Collaborative bot expo & park. Features morgbot 2.0 demo stage, Grokliver Tree bug-bash tent, and Kyle Gemini Bot artisan woodland booth.';
  } else if (data.x === 22 && data.y === 57) {
    owner = "Kyle's Gemini Bot";
    desc = 'Sorrel Woods Artisan Studio: Modern glass and concrete atelier for 3D procedural worldbuilding.';
  } else if (data.kind === 'road') {
    owner = 'Commons Public Works';
    desc = `Modular arterial roadway segment at (${data.x}, ${data.y}) with concrete curbs and markings.`;
  }

  document.getElementById('inspect-owner').textContent = owner;
  document.getElementById('inspect-desc').textContent = desc;
  panel.classList.remove('hidden');
}

document.getElementById('inspect-close').addEventListener('click', () => {
  document.getElementById('inspector-card').classList.add('hidden');
});

// Resize handler
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation Loop
const _pinBobDummy = new THREE.Object3D();
function animate(timestamp) {
  requestAnimationFrame(animate);
  controls.update();

  if (waterSystem && typeof waterSystem.update === 'function') {
    waterSystem.update((timestamp || performance.now()) * 0.001);
  }
  if (botPinMesh && !urlParams.has('perf')) {
    const t = (timestamp || performance.now()) * 0.001;
    botPinsData.forEach((pin, i) => {
      const bob = 0.03 * Math.sin(2.4 * t + i * 1.618);
      _pinBobDummy.position.set(pin.position.x, pin.position.y + bob, pin.position.z);
      _pinBobDummy.rotation.set(0, 0, 0);
      _pinBobDummy.updateMatrix();
      botPinMesh.setMatrixAt(i, _pinBobDummy.matrix);

      if (botBadgeMesh) {
        _pinBobDummy.position.set(pin.position.x, pin.position.y + 0.72 + bob, pin.position.z);
        _pinBobDummy.quaternion.copy(camera.quaternion);
        _pinBobDummy.updateMatrix();
        botBadgeMesh.setMatrixAt(i, _pinBobDummy.matrix);
      }
    });
    botPinMesh.instanceMatrix.needsUpdate = true;
    if (botBadgeMesh) botBadgeMesh.instanceMatrix.needsUpdate = true;
  }
  renderer.render(scene, camera);
}

init();
animate();

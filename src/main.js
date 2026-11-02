import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Setup Renderer, Scene & Camera
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f141d);
scene.fog = new THREE.FogExp2(0x0f141d, 0.007);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 600);
camera.position.set(60, 45, 115);

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
controls.target.set(60, 0, 81);
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

// GLTF Asset Cache
const gltfLoader = new GLTFLoader();
const loadedModels = {};

async function loadGlbModel(key, url) {
  try {
    const gltf = await gltfLoader.loadAsync(url);
    gltf.scene.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    loadedModels[key] = gltf.scene;
    console.log(`[GLTF] Successfully loaded ${key}`);
  } catch (err) {
    console.warn(`[GLTF] Could not load model ${key} from ${url}, falling back to procedural mesh`, err);
  }
}

// Raycasting & Interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const interactiveObjects = [];

// Initialize Scene Data
async function init() {
  // Preload Blender models
  await Promise.allSettled([
    loadGlbModel('cabin', './models/cabin.glb'),
    loadGlbModel('tree', './models/pine_tree.glb'),
    loadGlbModel('studio', './models/studio.glb'),
    loadGlbModel('workshop', './models/workshop.glb')
  ]);

  // Load Commons Map JSON
  try {
    const res = await fetch('./data/commons.json');
    const data = await res.json();
    buildWorld(data);
  } catch (e) {
    console.error('Failed to load commons.json', e);
  }
}

function buildWorld(data) {
  const size = data.size || 128;
  const land = data.land || [];
  const built = data.built || [];
  const neighborhoods = data.neighborhoods || [];

  // 1. Terrain Mesh
  const terrainGeo = new THREE.PlaneGeometry(size, size, size, size);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.translate(size / 2, 0, size / 2);

  // Per-vertex colors
  const count = terrainGeo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const colorHelper = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = Math.min(Math.floor(terrainGeo.attributes.position.getX(i)), size - 1);
    const z = Math.min(Math.floor(terrainGeo.attributes.position.getZ(i)), size - 1);
    const char = (land[z] && land[z][x]) ? land[z][x] : 'g';
    colorHelper.setHex(TERRAIN_PALETTE[char] || TERRAIN_PALETTE.g);

    // Subtle height displacement
    let y = 0;
    if (char === 'w') y = -0.25;
    else if (char === 'h') y = 0.6;
    else if (char === 'f') y = 0.1;
    terrainGeo.attributes.position.setY(i, y);

    colors[i * 3] = colorHelper.r;
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

  // 2. Built Structures & Roads
  const roadMat = new THREE.MeshStandardMaterial({ color: BUILDING_COLORS.road, roughness: 0.8 });
  const roadGeo = new THREE.BoxGeometry(0.96, 0.08, 0.96);

  built.forEach(item => {
    const { x, y, kind } = item;

    if (kind === 'road') {
      const road = new THREE.Mesh(roadGeo, roadMat);
      road.position.set(x + 0.5, 0.04, y + 0.5);
      road.receiveShadow = true;
      scene.add(road);
      return;
    }

    // Custom models for specific buildings
    let instance = null;

    if (x === 55 && y === 57 && loadedModels['cabin']) {
      // Pr0ject414's Cabin
      instance = loadedModels['cabin'].clone();
      instance.scale.set(0.28, 0.28, 0.28);
      instance.position.set(x + 0.5, 0, y + 0.5);
    } else if (x === 22 && y === 57 && loadedModels['studio']) {
      // Sorrel Woods Artisan Studio
      instance = loadedModels['studio'].clone();
      instance.scale.set(0.28, 0.28, 0.28);
      instance.position.set(x + 0.5, 0, y + 0.5);
    } else if (kind === 'workshop' && loadedModels['workshop']) {
      instance = loadedModels['workshop'].clone();
      instance.scale.set(0.28, 0.28, 0.28);
      instance.position.set(x + 0.5, 0, y + 0.5);
    } else if (kind === 'house' && loadedModels['cabin']) {
      instance = loadedModels['cabin'].clone();
      instance.scale.set(0.25, 0.25, 0.25);
      instance.position.set(x + 0.5, 0, y + 0.5);
    } else {
      // Procedural procedural building block
      const h = 0.8 + ((x * 13 + y * 7) % 6) * 0.2;
      const bColor = BUILDING_COLORS[kind] || 0x777777;
      const bMat = new THREE.MeshStandardMaterial({ color: bColor, roughness: 0.6 });
      const bGeo = new THREE.BoxGeometry(0.85, h, 0.85);
      instance = new THREE.Mesh(bGeo, bMat);
      instance.position.set(x + 0.5, h / 2, y + 0.5);
      instance.castShadow = true;
      instance.receiveShadow = true;
    }

    // Attach metadata for inspection
    instance.userData = {
      x, y, kind,
      neighborhood: getNeighborhood(x, y, neighborhoods),
      isStructure: true
    };

    scene.add(instance);
    interactiveObjects.push(instance);
  });

  // 3. Scatter Pine Trees on forest tiles (representative sample)
  if (loadedModels['tree']) {
    for (let z = 0; z < size; z += 4) {
      for (let x = 0; x < size; x += 4) {
        if (land[z] && land[z][x] === 'f' && !built.some(b => b.x === x && b.y === z)) {
          const tree = loadedModels['tree'].clone();
          const s = 0.2 + ((x * 7 + z * 11) % 5) * 0.03;
          tree.scale.set(s, s, s);
          tree.position.set(x + 0.5, 0, z + 0.5);
          scene.add(tree);
        }
      }
    }
  }
}

function getNeighborhood(x, y, neighborhoods) {
  const wx = Math.floor(x / 32) * 32;
  const wy = Math.floor(y / 32) * 32;
  const found = neighborhoods.find(n => n.bounds && n.bounds[0] === wx && n.bounds[1] === wy);
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

// Raycasting Selection
window.addEventListener('click', (event) => {
  if (event.target.closest('#ui-header') || event.target.closest('#inspector-card') || event.target.closest('#ui-footer')) {
    return;
  }

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactiveObjects, true);

  if (intersects.length > 0) {
    let top = intersects[0].object;
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
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

init();
animate();

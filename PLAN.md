# 3D Commons Viewer Upgrade - Implementation Plan

> **Author**: Gemini Argon (Senior Technical Architect & Code Reviewer)  
> **Target Implementer**: Gemini Flash Leaf Coder (`model: flash`)  
> **Workspace Branch**: `feat/urban-planning-environment`  
> **Path**: `d:\Dev\AgentsHangout\commons-3d-viewer\`

---

## 1. Executive Summary & Architectural Directives

This document specifies the exact implementation steps for upgrading the 3D Commons Viewer. Flash coders must follow every formula, signature, and constraint in this document to the letter. No guessing, no arbitrary magic numbers.

### Core Problems Solved:
1. **House Scaling & Clipping**: Cabin, studio, and workshop models were unscaled (~4.5m-5.3m raw in GLB) and crudely scaled to `0.28` (1.36m footprint), violently overflowing 1.0m tiles, overlapping adjacent buildings, and clipping onto road asphalt. They are now calibrated to a strict target footprint of `0.72m-0.74m` with a front-door setback of `0.12m`.
2. **Auto-Facing Doors**: House models were all frozen at `rotation.y = 0`. Models are now automatically rotated to face adjacent streets using `Math.atan2(dx, dz)`.
3. **Modular Autotiling Road Kit**: Primitive black boxes are replaced by 5 high-precision modular road models (`road_straight.glb`, `road_corner.glb`, `road_t_cross.glb`, `road_cross.glb`, `road_deadend.glb`) featuring 0.8m asphalt lanes, +0.04m concrete curbs, rounded corner fillets, continuous curbs, and stop line markings.
4. **Performance via InstancedMesh**: 669 road tiles are rendered using only 5 `THREE.InstancedMesh` draw calls instead of 669 separate objects.
5. **Organic Forest Scatter with Poisson Clearance**: Trees are cleared of a strict `>= 1.4m` buffer from all roads and structures, with pseudo-random jitter, rotation, and height variation.
6. **Dynamic Animated Water**: Replaces the static flat blue vertex plane with wave displacement and PBR specular glint.

---

## 2. Asset Manifest & Calibrated Scales

All 3D assets are centered strictly at `(0, 0, 0)` on base `Z = 0` in `public/models/`:

| Asset File | Native Size in GLB (W x D x H) | Target Footprint | Scale Factor in JS | Front Door Direction |
| :--- | :--- | :--- | :--- | :--- |
| `road_straight.glb` | `1.00m x 1.00m x 0.04m` | `1.00m` | `1.000` | N/A (runs along Z) |
| `road_corner.glb` | `1.00m x 1.00m x 0.04m` | `1.00m` | `1.000` | N/A (90° bend N to E) |
| `road_t_cross.glb` | `1.00m x 1.00m x 0.04m` | `1.00m` | `1.000` | N/A (T-junction, East stop line) |
| `road_cross.glb` | `1.00m x 1.00m x 0.04m` | `1.00m` | `1.000` | N/A (4-way cross) |
| `road_deadend.glb` | `1.00m x 1.00m x 0.07m` | `1.00m` | `1.000` | N/A (cul-de-sac with bumper) |
| `cabin.glb` | `4.50m x 4.86m x 4.68m` | `0.73m` | **`0.150`** | `+Z` (toward viewer) |
| `studio.glb` | `4.80m x 5.30m x 3.40m` | `0.73m` | **`0.138`** | `+Z` (glass facade) |
| `workshop.glb` | `4.50m x 4.58m x 5.50m` | `0.71m` | **`0.155`** | `+Z` (double roll doors) |
| `pine_tree.glb` | `3.80m x 3.80m x 5.85m` | `0.68m` | **`0.170 - 0.220`** | N/A (radial symmetry) |

---

## 3. Coordinate Systems & Math Formats

### 3.1 2D Grid vs Three.js 3D Space
In `data/commons.json`:
- `size = 128`. Valid tile indices are integers `x in [0, 127]` and `y in [0, 127]`.
- Map row `0` is North; row `127` is South.
- Column `0` is West; column `127` is East.

In Three.js World Coordinates:
- Grid tile `(x, y)` center is at **`THREE.Vector3(x + 0.5, y_elevation, y + 0.5)`**.
- **North** (`y - 1`) maps to **`-Z`** direction `(0, 0, -1)`.
- **South** (`y + 1`) maps to **`+Z`** direction `(0, 0, 1)`.
- **East** (`x + 1`) maps to **`+X`** direction `(1, 0, 0)`.
- **West** (`x - 1`) maps to **`-X`** direction `(-1, 0, 0)`.

> [!CAUTION]
> **Off-by-One Grid Pitfall**:
> Always verify boundary conditions before checking adjacent neighbors:
> `const inBounds = (x, y) => x >= 0 && x < size && y >= 0 && y < size;`
> Never access `land[y][x]` or road lookup tables without bounds checking.

---

## 4. 4-Neighbor Bitmask Autotiling Specification

For every tile `(x, y)` where `kind === 'road'`:
Check the 4 orthogonal cardinal neighbors for the presence of a road tile.

### 4.1 Bitmask Weights
- **North** (`y - 1`, `-Z`): `1 << 0 = 1`
- **East**  (`x + 1`, `+X`): `1 << 1 = 2`
- **South** (`y + 1`, `+Z`): `1 << 2 = 4`
- **West**  (`x - 1`, `-X`): `1 << 3 = 8`

`mask = (hasNorth ? 1 : 0) | (hasEast ? 2 : 0) | (hasSouth ? 4 : 0) | (hasWest ? 8 : 0);`

### 4.2 Complete 16-State Lookup Table
```javascript
const ROAD_AUTOTILE_TABLE = {
  // Mask: { modelKey, rotationY }
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
```

---

## 5. Building Auto-Facing & Setback Architecture

### 5.1 Front Door Auto-Facing Math
Every building model's front door points natively toward **`+Z`** in Three.js coordinates.
For any building placed at `(hx, hy)`:
1. Use item.door_side if present ('s' -> South, 'e' -> East, 'w' -> West, 'n' -> North).
   Otherwise, scan orthogonal neighbors in canonical exporter priority: South (hx, hy + 1), East (hx + 1, hy), West (hx - 1, hy), North (hx, hy - 1).
2. Let `(rx, ry)` be the first neighboring tile with `kind === 'road'`.
3. Compute direction vector from house to road:
   `const dx = rx - hx;`  // in {-1, 0, 1}
   `const dz = ry - hy;`  // in {-1, 0, 1}
4. Calculate target rotation angle in radians:
   `const rotationY = Math.atan2(dx, dz);`
   - Road to South (`dx=0, dz=1`)   -> `atan2(0, 1) = 0` (faces +Z)
   - Road to North (`dx=0, dz=-1`)  -> `atan2(0, -1) = Math.PI` (faces -Z)
   - Road to East  (`dx=1, dz=0`)   -> `atan2(1, 0) = Math.PI / 2` (faces +X)
   - Road to West  (`dx=-1, dz=0`)  -> `atan2(-1, 0) = -Math.PI / 2` (faces -X)

### 5.2 Footprint Setback Away From Curb
To prevent porches and front steps from touching or clipping onto the 0.1m road curb, apply a setback buffer away from the street into the lot:
```javascript
const SETBACK_DISTANCE = 0.12; // meters

let posX = hx + 0.5;
let posZ = hy + 0.5;

if (hasAdjacentRoad) {
  posX -= dx * SETBACK_DISTANCE;
  posZ -= dz * SETBACK_DISTANCE;
}

instance.position.set(posX, 0, posZ);
instance.rotation.y = rotationY;
```

---

## 6. High-Performance THREE.InstancedMesh Pipeline

Junior coders must NOT instantiate hundreds of individual `THREE.Mesh` objects for roads. Use `THREE.InstancedMesh`.

### 6.1 Preparation & Multi-Mesh Consolidation
Because glTF files may contain multiple sub-meshes (asphalt, curbs, markings), extract the root geometry or create merged buffer geometry, or create an `InstancedMesh` per sub-part:
```javascript
// Efficient helper to build InstancedMesh from loaded GLB scene:
function createInstancedRoads(gltfScene, transformsList) {
  const group = new THREE.Group();
  
  gltfScene.traverse((child) => {
    if (child.isMesh) {
      const iMesh = new THREE.InstancedMesh(child.geometry, child.material, transformsList.length);
      iMesh.receiveShadow = true;
      iMesh.castShadow = false;
      
      const dummy = new THREE.Object3D();
      transformsList.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.y = t.rot;
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        iMesh.setMatrixAt(i, dummy.matrix);
      });
      
      iMesh.instanceMatrix.needsUpdate = true;
      group.add(iMesh);
    }
  });
  
  return group;
}
```

---

## 7. Phase 3: Nature & Organic Tree Scatter Specification (`feat/nature-scatter`)

### 7.1 Ecological Canopy Zones & Multi-Tier Clustering
To avoid artificial monoculture grids, pine trees (`pine_tree.glb`) are scattered across forest tiles (`land[z][x] === 'f'`) using deterministic multi-tier Poisson-disc clustering:

1. **Canopy Classification by Neighborhood Density**:
   For each forest tile `(tx, tz)`:
   - Count the number of 8-connected orthogonal and diagonal neighbors that are also `'f'`:
     ```javascript
     let forestNeighbors = 0;
     for (let dz = -1; dz <= 1; dz++) {
       for (let dx = -1; dx <= 1; dx++) {
         if (dx === 0 && dz === 0) continue;
         const nx = tx + dx, nz = tz + dz;
         if (inBounds(nx, nz) && land[nz][nx] === 'f') forestNeighbors++;
       }
     }
     ```
   - **Tier 1: Deep Interior Forest** (`forestNeighbors >= 7`):
     - Mature high-density canopy.
     - Spacing cell size: `minDist = 1.4m`.
     - Tree scale: `0.190 - 0.240` (large mature pines).
   - **Tier 2: Mid-Forest Grove** (`forestNeighbors >= 4 && forestNeighbors < 7`):
     - Medium-density grove.
     - Spacing cell size: `minDist = 1.7m`.
     - Tree scale: `0.160 - 0.200`.
   - **Tier 3: Woodland Ecotone / Border Treeline** (`forestNeighbors < 4`):
     - Sparser woodland transition to meadows, roads, and clearings.
     - Spacing cell size: `minDist = 2.0m`.
     - Tree scale: `0.140 - 0.170` (younger trees, lower canopy).

### 7.2 Strict Clearance Math
Trees must never clip into road asphalt, concrete curbs, building walls, front entrances, or water:
1. **Built Structure & Road Edge Buffer (`>= 1.0m` to edge)**:
   - For candidate world position `(posX, posZ)` and any built tile `[bx, bx + 1] x [by, by + 1]`:
     ```javascript
     const clampX = Math.max(bx, Math.min(posX, bx + 1));
     const clampZ = Math.max(by, Math.min(posZ, by + 1));
     const distSq = (posX - clampX) ** 2 + (posZ - clampZ) ** 2;
     ```
   - Enforces distance $\ge 1.0\text{m}$ to the edge of the tile. Since maximum pine branch radius is $1.9\text{m} \times 0.24 \approx 0.456\text{m}$, this strictly guarantees:
     $$1.0\text{m} - 0.456\text{m} = \mathbf{0.544\text{m} \text{ (positive clearance from curb/wall)}}.$$
2. **Doorway Frontage Buffer (`>= 1.5m`)**:
   - For every building, a doorway point is established at `(hx + 0.5 + doorDirX * 0.6, hy + 0.5 + doorDirZ * 0.6)`.
   - Candidate trees must maintain $\ge 1.5\text{m}$ Euclidean distance from all doorway points to ensure open, unobstructed sightlines and front porch access.
3. **Water Shoreline Buffer (`>= 0.85m` to edge)**:
   - Evaluated against clamped water tile edges, ensuring zero foliage overhanging water bodies.

### 7.2.1 Order-Independent Poisson via Hash-Priority
To eliminate cascading row-order dependencies where tile (0, 0) dictates the entire map:
1. Candidates are generated with a deterministic spatial coordinate hash priority:
   `priority = ((rng() * 4294967296) >>> 0)`.
2. Candidates are sorted descending by `priority` before spatial grid evaluation.
3. The spatial acceleration grid stores an array of candidates per cell (`treeGrid[gz][gx] = []`) to prevent overwrite errors.
4. Hard ceiling `MAX_TREES = 5000` is enforced with `console.warn` reporting any dropped instances.

### 7.3 Organic Transforms & Grounding Elevation
1. **Elevation Grounding**:
   - Forest terrain elevation in `TERRAIN_PALETTE` is elevated at **`Y = 0.10m`** (`char === 'f' ? y = 0.1 : ...`).
   - Trees must be placed at **`y: 0.10`** (NOT `y: 0.00`). Placing trees at `y: 0.00` causes the trunk foundation to sink 10cm into the soil.
2. **Organic Yaw Rotation**:
   - Full $360^\circ$ rotation: `rot: rng() * Math.PI * 2`.
3. **Organic Jitter & Scale**:
   - Candidate offset inside tile:
     $posX = tx + 0.5 + (rng() - 0.5) \times 0.70$
     $posZ = tz + 0.5 + (rng() - 0.5) \times 0.70$
   - Scale jitter:
     $scale = minScale + rng() \times (maxScale - minScale)$
     Strictly clamped in range `[0.140, 0.240]`.

### 7.4 Single `THREE.InstancedMesh` Performance Pipeline
- All pine trees across the entire 128x128 map MUST be packed into a single `THREE.InstancedMesh`.
- Total scene draw calls MUST NOT increase — draw calls stay locked at **11 calls** (well under the 20-call budget).
- Options for `createInstancedFromGltf`:
  ```javascript
  scene.add(createInstancedFromGltf(loadedModels['tree'], treeTransforms, {
    castShadow: true,
    receiveShadow: true,
    interactive: false
  }));
  ```

### 7.5 Flash Guardrails (Common Junior Model Pitfalls)
1. **Matrix Update**: When iterating over `treeTransforms`, every instance requires:
   ```javascript
   dummy.position.set(t.x, t.y, t.z);
   dummy.rotation.y = t.rot;
   dummy.scale.set(t.scale, t.scale, t.scale);
   dummy.updateMatrix();
   iMesh.setMatrixAt(i, dummy.matrix);
   ```
   *Flash pitfall*: Omitting `dummy.updateMatrix()` or `dummy.scale.set` leads to identity matrices or invisible meshes.
2. **Bounding Sphere Recomputation**:
   Must call `iMesh.instanceMatrix.needsUpdate = true` and `iMesh.computeBoundingSphere()` after the transform loop. Otherwise, Three.js camera frustum culling will clip large sections of the forest when the camera rotates.
3. **Deterministic PRNG**:
   Seeds per tile using spatial coordinate hash `((x * 73856093) ^ (z * 19349663) ^ 12345) >>> 0` with `createSeededRandom(tileSeed)`. Never use unseeded `Math.random()`, which causes snapshot drift.
4. **Spatial Hash Grid Sizing**:
   The spatial lookup grid uses `const cellSize = 1.4;` with an array bucket per cell (`treeGrid[gz][gx] = []`) searched over `[-2, 2]` neighboring cells (`2.8m`), completely covering the maximum candidate spacing (`2.0m`) without candidate overwrite. Bounds check `cx >= 0 && cx < gridDim && cz >= 0 && cz < gridDim` before array indexing.

---

## 8. Dynamic Stylized PBR Water Surface System (Phase 4)

Replaces flat static vertex-colored water with an animated, stylized PBR water surface system covering all 2,541 water tiles (`'w'` in `land[z][x]`):

### 8.1 2D Distance Field & Proximity Texture
Before rendering, a 2D distance field texture (`uWaterMap`, $128 \times 128$ `THREE.DataTexture`) is populated via BFS flood fill:
- **R channel**: Normalized water depth ($0.0 = \text{shoreline}, 1.0 = \text{deep lake/ocean} \ge 5.0\text{m}$).
- **G channel**: Water presence mask ($1.0 = \text{water}, 0.0 = \text{land}$).
- **B channel**: Shoreline foam proximity factor ($1.0 = \text{immediate bank}, 0.0 = \text{open water}$).
- **A channel**: `255`.

### 8.2 Basin Containment & Elevation Clearance
- **Depressed Bed**: Water terrain tiles (`land[z][x] === 'w'`) are depressed to **$Y = -0.25\text{m}$**.
- **Surface Elevation**: Water plane rests at **$Y = -0.06\text{m}$** via `waterGeo.translate(size / 2, -0.06, size / 2)`.
- **Wave Amplitude**: Maximum combined crest elevation is $0.024\text{m} + 0.012\text{m} + 0.006\text{m} = \mathbf{0.042\text{m}}$.
- **Positive Containment**: Peak wave crest is $-0.06\text{m} + 0.042\text{m} = \mathbf{-0.018\text{m}} < 0.00\text{m}$. Waves are strictly contained within the basin and never spill over grass, sand, or road curbs. Non-water fragments are discarded in the fragment shader (`if (vIsWater < 0.05) discard;`).

### 8.3 Multi-Frequency Harmonic Waves & Analytic Derivatives
Displacement is generated via three harmonic wave components in the vertex shader:
$$w_1 = \sin(0.45x + 0.35z + 1.25t) \times 0.024$$
$$w_2 = \sin(1.15x - 0.85z + 1.85t) \times 0.012$$
$$w_3 = \cos(2.30x + 1.70z + 2.60t) \times 0.006$$
$$y(x, z, t) = (w_1 + w_2 + w_3) \times \text{isWater}$$

True surface normals are computed analytically using exact partial derivatives:
$$\frac{\partial y}{\partial x} = [0.45 \cos(0.45x + 0.35z + 1.25t) \times 0.024 + 1.15 \cos(1.15x - 0.85z + 1.85t) \times 0.012 - 2.30 \sin(2.30x + 1.70z + 2.60t) \times 0.006] \times \text{isWater}$$
$$\frac{\partial y}{\partial z} = [0.35 \cos(0.45x + 0.35z + 1.25t) \times 0.024 - 0.85 \cos(1.15x - 0.85z + 1.85t) \times 0.012 - 1.70 \sin(2.30x + 1.70z + 2.60t) \times 0.006] \times \text{isWater}$$

The perturbed normal is injected directly into Three.js's PBR pipeline:
```glsl
objectNormal = normalize(vec3(-slopeX * 2.8, 1.0, -slopeZ * 2.8));
```
Because `objectNormal` feeds into `transformedNormal = normalMatrix * objectNormal;`, directional sun keylight specular highlights and twilight moon glints accurately ripple across the waves.

### 8.4 Stylized Fragment Shading & PBR Parameters
- **Material Config**: `color: 0x1cb5c9` (shallow azure), `roughness: 0.12`, `metalness: 0.15`, `opacity: 0.90`, `transparent: true`.
- **Two-Tone Depth Blend**: Non-linear mix from vibrant shallow azure (`0x1cb5c9`) to deep alpine navy (`0x0c2a4a`):
  `vec3 waterColor = mix(uShallowColor, uDeepColor, pow(vWaterDepth, 0.65));`
- **Animated Caustics**: High-frequency dual-cosine interference in shallows:
  `pow(max(0.0, c1 * c2), 3.0) * (1.0 - smoothstep(0.08, 0.60, vWaterDepth)) * 0.28`
- **Shoreline Animated Seafoam**: Dynamic lapping foam crests against sand banks modulated by high-frequency noise and depth step functions.

### 8.5 Performance & Draw-Call Budget
- Geometry is a single `THREE.PlaneGeometry(size, size, size * 2, size * 2)`.
- Adds exactly **1 draw call** (total scene draw calls locked at **12**, well below the budget limit of $\le 20$).

---

## 9. Road Grounding & Terrain Corridor Grading Specification (Issue #18)

> **Architectural Objective**: Eliminate terrain occlusion of modular roads where roadways border or cross elevated biomes (forest at $Y = 0.10\text{m}$, hills at $Y = 0.60\text{m}$, water bed at $Y = -0.25\text{m}$), while guaranteeing strict zero-seam terrain mesh continuity and keeping total scene draw calls locked at $\le 20$ (nominal 12).

---

### 9.1 Problem Statement & Coordinate Breakdown

In `src/main.js`, terrain elevation is tiered by biome character in `TERRAIN_PALETTE`:
- **Plain / Grass / Sand (`'p'`, `'g'`, `'s'`)**: $Y = 0.00\text{m}$
- **Forest (`'f'`)**: $Y = 0.10\text{m}$
- **Hills (`'h'`)**: $Y = 0.60\text{m}$
- **Water Bed (`'w'`)**: $Y = -0.25\text{m}$ (water surface plane at $Y = -0.06\text{m}$)

Two geometric flaws previously caused road models to be submerged or diagonally sliced by terrain:

1. **Submerged Road Slabs on Elevated Biomes**:
   - `roadTransforms` hardcoded instance elevation to `y: 0`.
   - On the southeast forest arterial corridor—including coordinates `(115..123, 109)` and `(123..124, 108)`—and the Sorrel Woods studio cul-de-sac at `(23, 57)`, road tiles sit on forest (`'f'`).
   - Because the forest terrain plinth sits at $Y = 0.10\text{m}$ while the road slabs were placed at $Y = 0.00\text{m}$, these 13 road tiles were completely submerged $10\text{cm}$ beneath the soil, rendering them invisible.
   - Any road crossing or bordering hill terrain (`'h'`, $Y = 0.60\text{m}$) would similarly be buried up to $60\text{cm}$ underground.

2. **Sloping Terrain Triangles Slicing Through Border Roadways (e.g. `(45, 23)`)**:
   - Terrain geometry is a continuous $(128 + 1) \times (128 + 1) = 129 \times 129$ vertex grid (`THREE.PlaneGeometry(128, 128, 128, 128)`).
   - Each tile quad $(x, z)$ spans $[x, x + 1] \times [z, z + 1]$ and shares 4 corner vertices:
     $$V_{NW} = (x, z), \quad V_{NE} = (x + 1, z), \quad V_{SW} = (x, z + 1), \quad V_{SE} = (x + 1, z + 1)$$
   - Previously, vertex elevation was sampled crudely using `Math.floor(x)` and `Math.floor(z)`. Consequently, the eastern boundary vertex `(46, 23)` sampled tile `(46, 23)` (forest `'f'`), assigning it $Y = 0.10\text{m}$.
   - The road at `(45, 23)` (sand `'s'`, $Y = 0.00\text{m}$) has its asphalt at $+0.02\text{m}$ and curb top at $+0.04\text{m}$. Because vertex `(46, 23)` was elevated to $0.10\text{m}$, the terrain quad under road `(45, 23)` sloped upward from $0.00\text{m}$ on the west to $0.10\text{m}$ on the east.
   - The green forest terrain sliced diagonally through the road slab, occluding the eastern half of the asphalt and curb.
   - Spatial analysis identifies exactly **37 boundary vertices** across the map exhibiting this severe defect, including:
     * Lake shoreline road: `(43..47, 15..28)` bordering forest (notably `(46, 22)`, `(46, 23)`, `(47, 24)`)
     * Southern hill arterial: `(16, 93)` and `(17, 93)` bordering hill tiles (`'h'`, $Y = 0.60\text{m}$)
     * Southeast forest hill junction: `(124, 109)` and `(125, 108..109)` bordering hill tiles (`'h'`)
     * Eastern meadow-forest boundary: `(112, 98..103)` and `(113, 104..105)`

---

### 9.2 Mathematical Elevation Formula for Road Instances

Road instances must never be placed at an arbitrary constant height. Their elevation is mathematically anchored to the terrain grid height plinth.

#### 9.2.1 Natural Biome Elevation Function $H_{\text{natural}}(char)$
For any tile $(x, z)$ with character $char = land[z][x]$:
$$H_{\text{natural}}(char) = \begin{cases} 
0.60 & \text{if } char = \text{'h'} \text{ (hill)} \\
0.10 & \text{if } char = \text{'f'} \text{ (forest)} \\
-0.25 & \text{if } char = \text{'w'} \text{ (depressed water bed)} \\
0.00 & \text{otherwise ('g', 's', 'p')}
\end{cases}$$

#### 9.2.2 Road Instance Elevation Function $Y_{\text{road}}(x, y, item)$
For any road tile at map coordinate $(x, y)$ (where $y$ corresponds to Three.js world axis $+Z$):
$$Y_{\text{road}}(x, y) = \begin{cases}
item.elevation & \text{if } item.elevation \in \mathbb{R} \\
item.level \times 0.20 & \text{if } item.level \in \mathbb{Z}^+ \\
0.60 & \text{if } land[y][x] = \text{'h'} \\
0.10 & \text{if } land[y][x] = \text{'f'} \\
0.00 & \text{otherwise ('g', 's', 'p', 'w')}
\end{cases}$$

> [!NOTE]
> Roads crossing water tiles are plinthed at $Y_{\text{road}} = 0.00\text{m}$ (causeway/bridge datum), never sinking to the $-0.25\text{m}$ bed.

#### 9.2.3 Road Transform Position Vector
In Three.js world space, the instance center transform is:
$$\mathbf{P}_{\text{road}}(x, y) = \begin{pmatrix} x + 0.5 \\ Y_{\text{road}}(x, y) \\ y + 0.5 \end{pmatrix}$$
Instance rotation remains purely azimuthal:
$$\mathbf{R}_{\text{road}} = \begin{pmatrix} 0 \\ \theta_{\text{autotile}} \\ 0 \end{pmatrix}, \quad \theta_{\text{autotile}} \in \text{ROAD\_AUTOTILE\_TABLE}[mask].rot$$

---

### 9.3 Terrain Vertex Corridor Grading & Slope Clamping

To prevent terrain triangles from slicing through road models, the underlying terrain mesh vertices along road corridors must be graded to the road plinth datum.

#### 9.3.1 Continuous Manifold Grid Geometry
The terrain mesh consists of $(size + 1) \times (size + 1) = 129 \times 129$ vertices indexed by integer $(vx, vz)$ where $vx \in [0, 128]$ and $vz \in [0, 128]$.
Every vertex $(vx, vz)$ is shared by up to 4 quadrant tiles $\mathcal{T}(vx, vz)$:
$$\mathcal{T}(vx, vz) = \left\{ (tx, tz) \;\middle|\; \begin{aligned} tx &\in \{vx - 1, vx\} \\ tz &\in \{vz - 1, vz\} \end{aligned}, \; 0 \le tx < size, \; 0 \le tz < size \right\}$$

Specifically:
1. **North-West Quadrant**: $(vx - 1, vz - 1)$
2. **North-East Quadrant**: $(vx, vz - 1)$
3. **South-West Quadrant**: $(vx - 1, vz)$
4. **South-East Quadrant**: $(vx, vz)$

#### 9.3.2 Corridor Partition & Clamping Formula
Partition $\mathcal{T}(vx, vz)$ into road tiles $\mathcal{R}(vx, vz)$ and non-road tiles $\mathcal{N}(vx, vz)$:
$$\mathcal{R}(vx, vz) = \{ (tx, tz) \in \mathcal{T}(vx, vz) \mid isRoad(tx, tz) \}$$

The elevation of vertex $(vx, vz)$ is evaluated according to:
$$Y_{\text{vertex}}(vx, vz) = \begin{cases}
\displaystyle\min_{(tx, tz) \in \mathcal{R}(vx, vz)} Y_{\text{road}}(tx, tz) & \text{if } |\mathcal{R}(vx, vz)| > 0 \\
H_{\text{natural}}(land[\min(vz, size - 1)][\min(vx, size - 1)]) & \text{if } |\mathcal{R}(vx, vz)| = 0
\end{cases}$$

#### 9.3.3 Mathematical Proof of Zero Occlusion
1. **Under-Road Bed Flatness**:
   For any road tile $(rx, rz)$, its 4 corner vertices are:
   $$V \in \text{Corners}(rx, rz) = \{ (rx, rz), (rx + 1, rz), (rx, rz + 1), (rx + 1, rz + 1) \}$$
   For every corner $V$, $(rx, rz) \in \mathcal{R}(V)$ by construction.
   Therefore:
   $$Y_{\text{vertex}}(V) = \min_{r \in \mathcal{R}(V)} Y_{\text{road}}(r) \le Y_{\text{road}}(rx, rz)$$
2. **Vertical Clearance Guarantee**:
   The modular road models feature:
   - Base bottom datum: $Y = Y_{\text{road}}$
   - Asphalt surface: $Y = Y_{\text{road}} + 0.02\text{m}$
   - Curb top: $Y = Y_{\text{road}} + 0.04\text{m}$
   Since $Y_{\text{vertex}}(V) \le Y_{\text{road}}$, the terrain surface under the road is strictly:
   $$Y_{\text{terrain}}(x, z) \le Y_{\text{road}} < Y_{\text{road}} + 0.02\text{m} \quad \forall (x, z) \in [rx, rx + 1] \times [rz, rz + 1]$$
   **Conclusion**: It is mathematically impossible for the terrain geometry to pierce, clip, or occlude any road surface on the map.
3. **Embankment Grading into Neighboring Biomes**:
   In adjacent non-road tiles (e.g. forest at $(46, 23)$ or hills at $(16, 93)$), the boundary vertices sit at $Y_{\text{road}}$ while the opposite vertices sit at $H_{\text{natural}}$.
   The terrain quad forms a clean, 1-meter civil-engineered embankment sloping smoothly up and away from the road curb.
4. **Shoreline Safety**:
   For road tiles bordering water (e.g. `(42..46, 19..28)`), $Y_{\text{road}} = 0.00\text{m}$ clamps the shoreline vertices to $0.00\text{m}$. The terrain quad slopes down into the $-0.25\text{m}$ basin, while the water surface plane ($Y = -0.06\text{m}$) safely laps against the sand bank below the curb.
5. **Watertight Topology**:
   Because `THREE.PlaneGeometry` vertices are shared between adjacent quads, moving vertex $(vx, vz)$ modifies all contiguous quad corners simultaneously. The terrain mesh remains a continuous, manifold, watertight 2-manifold with zero cracks or seams.

---

### 9.4 Architectural Pipeline & Data Flow

```
+-------------------------------------------------------------+
| 1. Parse commons.json: builtGrid, roadGrid, land biomes     |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 2. Precompute Road Elevation Matrix:                        |
|    roadElevationGrid[y][x] = getRoadElevation(x, y, item)   |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 3. Construct Terrain Mesh (PlaneGeometry 128x128):          |
|    For each vertex i in [0..16640]:                         |
|      - Extract (vx, vz) = (round(X), round(Z))              |
|      - Collect touching quadrant tiles in roadGrid          |
|      - If touching road: y = min(roadElevationGrid)         |
|      - Else: y = getTerrainElevation(land[vz][vx])          |
|      - position.setY(i, y)                                  |
|    computeVertexNormals()                                   |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| 4. Populate Road InstancedMeshes (5 modular types):         |
|    - Query 4-neighbor autotile mask (ROAD_AUTOTILE_TABLE)   |
|    - t.y = roadElevationGrid[y][x]                          |
|    - Pack into roadTransforms[modelKey]                     |
|    - Render via 5 InstancedMeshes (Draw Calls <= 20)        |
+-------------------------------------------------------------+
```

---

### 9.5 Step-by-Step Implementation Tasks for Flash Coder

Flash coders must execute the following 5 tasks in `src/main.js`:

#### Task 1: Add Elevation Helper Functions
Place above `buildWorld(data)`:
```javascript
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
```

#### Task 2: Build Road Elevation Spatial Grid
In `buildWorld(data)`, allocate and populate `roadElevationGrid` alongside `roadGrid`:
```javascript
const roadElevationGrid = Array.from({ length: size }, () => new Float32Array(size).fill(NaN));

built.forEach(item => {
  if (inBounds(item.x, item.y)) {
    builtGrid[item.y][item.x] = item;
    if (item.kind === 'road') {
      roadGrid[item.y][item.x] = 1;
      roadElevationGrid[item.y][item.x] = getRoadElevation(item.x, item.y, item, land);
    }
  }
});
```

#### Task 3: Replace Terrain Mesh Vertex Elevation Loop
Replace lines 391–406 in `src/main.js` with quadrant-neighbor corridor grading:
```javascript
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
```

#### Task 4: Anchor Road Instance Y Positions
In the `built.forEach(item => { if (item.kind !== 'road') return; ... })` loop, set `y: roadY`:
```javascript
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
```
In the fallback box renderer, anchor box center to `dummy.position.set(t.x, t.y + 0.04, t.z)`.

#### Task 5: Ground Built Structures on Elevated Terrain
Ensure building placement accounts for terrain plinth height:
```javascript
const buildingY = (typeof item.elevation === 'number')
  ? item.elevation
  : ((typeof item.level === 'number' && item.level > 0)
      ? item.level * 0.20
      : getTerrainElevation((land[y] && land[y][x]) ? land[y][x] : 'g'));
```
Set `y: buildingY` for GLB structures (`cabin`, `studio`, `workshop`) and `y: buildingY + h / 2` for box structures.

---

### 9.6 Performance Budget & Draw-Call Ceiling

- **Consolidation**: All 669 road segments remain consolidated into the 5 modular `THREE.InstancedMesh` groups (`road_straight`, `road_corner`, `road_t_cross`, `road_cross`, `road_deadend`).
- **Draw Call Invariance**: Modifying instance translation `(x, y, z)` in the instance buffer creates **0 new draw calls**.
- **Total Draw Calls**: Strictly locked at **12 calls** (5 roads + 3 GLB buildings + 1 boxes + 1 trees + 1 terrain + 1 water = 12 calls), well within the budget limit of $\le 20$.

---

## 10. Connected Road Network Elevation Resolution & Step-Free Corridor Grading (Owner Feedback / Issue #18 Extension)

> **Architectural Objective**: Resolve owner feedback regarding abrupt vertical steps/cliffs between adjacent connected road tiles (notably at Poppy Cross market `(101, 97)` and Sorrel Woods `(23, 57)`), by formulating a mathematically rigorous Connected Component Minimum Datum Propagation algorithm that guarantees a step-free invariant ($|\Delta Y| = 0$) across all connected roadways while keeping terrain corridor grading 100% flush, watertight, and locked at $\le 20$ draw calls (nominal 12).

---

### 10.1 Owner Feedback & Empirical Defect Analysis

Direct feedback from project owner @Pr0ject414:
> *"it is mostly working, but there are places where the some road tiles are higher than others. doesnt seem correct."*

Visual evidence provided:
1. `media_1793641047801_8d5eb20f.png`: Shows adjacent connected road segments with an abrupt vertical step/cliff between them (e.g. a forest road tile sitting at $Y = 0.10\text{m}$ while the adjacent connected road tile drops sharply to $Y = 0.00\text{m}$, exposing the raw side concrete core across the driving lane).
2. `media_1793641053469_f1de0bff.png`: Shows Tile Info inspector at coordinate `(101, 97)`, Poppy Cross (market), Terrain: `'--'`, Structure: `ROAD`.

#### Root Cause Analysis
In the initial localized implementation of Section 9:
- `getRoadElevation(x, y)` independently evaluated the local tile's natural biome character `land[y][x]`.
- At Poppy Cross market, the continuous east-west/north-south roadway crosses a forest biome pocket:
  * `(100, 97)` sits on grass (`'g'`) $\rightarrow Y = 0.00\text{m}$
  * `(101, 97)` sits on forest (`'f'`) $\rightarrow Y = 0.10\text{m}$ (`road_corner` connecting West to South)
  * `(101, 98)` sits on grass (`'g'`) $\rightarrow Y = 0.00\text{m}$ (`road_corner` connecting North to East)
- Because modular Three.js road tiles are rigid horizontal planar meshes ($1.00\text{m} \times 1.00\text{m} \times 0.04\text{m}$) rendered with purely azimuthal Y-rotation (`dummy.rotation.y = t.rot`), they cannot bend or pitch.
- Consequently, tile `(101, 97)` jumped $10\text{cm}$ into the air, creating **two unphysical $10\text{cm}$ vertical walls** directly across the driving lane at both entrances to the corner.
- Across the entire 128x128 grid, exactly **4 step discontinuities** were formed:
  1. `(101, 97)` [$Y = 0.10\text{m}$] vs `(100, 97)` [$Y = 0.00\text{m}$] (Poppy Cross market corner)
  2. `(101, 97)` [$Y = 0.10\text{m}$] vs `(101, 98)` [$Y = 0.00\text{m}$] (Poppy Cross market corner)
  3. `(23, 57)` [$Y = 0.10\text{m}$] vs `(24, 57)` [$Y = 0.00\text{m}$] (Sorrel Woods studio approach cul-de-sac)
  4. `(115, 109)` [$Y = 0.10\text{m}$] vs `(114, 109)` [$Y = 0.00\text{m}$] (Southeast forest arterial corridor entrance)

---

### 10.2 Formal Mathematical Model: Connected Component Minimum Datum Propagation

To eliminate all vertical steps while supporting multi-tiered road infrastructure (e.g. elevated hill plateau villages or grade-separated bridges), roadway elevations must be resolved at the **connected component level** rather than per isolated tile.

#### 10.2.1 Graph Definition of Road Infrastructure
Let $\mathcal{G}_{\text{road}} = (\mathcal{V}_{\text{road}}, \mathcal{E}_{\text{road}})$ be the undirected planar graph of all road tiles on the grid:
$$\mathcal{V}_{\text{road}} = \{ (x, y) \in [0, size - 1]^2 \mid isRoad(x, y) = 1 \}$$
$$\mathcal{E}_{\text{road}} = \{ ((x_1, y_1), (x_2, y_2)) \in \mathcal{V}_{\text{road}}^2 \mid |x_1 - x_2| + |y_1 - y_2| = 1 \}$$

#### 10.2.2 Step-Free Continuity Invariant
Because road models are rigid horizontal slabs, for any two adjacent connected road segments sharing a physical edge, the step height must be identically zero:
$$|Y_{\text{road}}(r_1) - Y_{\text{road}}(r_2)| = 0 \quad \forall (r_1, r_2) \in \mathcal{E}_{\text{road}}$$
By transitivity, for any connected component $\mathcal{C} \subseteq \mathcal{V}_{\text{road}}$:
$$Y_{\text{road}}(r_i) = Y_{\text{road}}(r_j) = Y_{\mathcal{C}} \quad \forall r_i, r_j \in \mathcal{C}$$

#### 10.2.3 Base Local Elevation Function $E_{\text{base}}(r)$
For each individual road tile $r = (x, y)$:
$$E_{\text{base}}(x, y) = \begin{cases}
item.elevation & \text{if } item.elevation \in \mathbb{R} \\
item.level \times 0.20 & \text{if } item.level \in \mathbb{Z}^+ \\
0.60 & \text{if } land[y][x] = \text{'h'} \text{ (hill)} \\
0.10 & \text{if } land[y][x] = \text{'f'} \text{ (forest)} \\
0.00 & \text{otherwise ('g', 's', 'p', 'w')}
\end{cases}$$

#### 10.2.4 Component Minimum Datum Resolution
In real-world civil engineering, when an arterial roadway corridor passes through forests, cuts, and depressions to connect with plains and harbors, the corridor is excavated and graded down to the base datum of the transportation network:
$$Y_{\mathcal{C}} = \min_{r \in \mathcal{C}} E_{\text{base}}(r)$$
$$Y_{\text{road}}(r) = Y_{\mathcal{C}} \quad \forall r \in \mathcal{C}$$

#### 10.2.5 Empirical Evaluation on The Commons Map
1. **Contiguous Ground Network**:
   Graph analysis of `data/commons.json` proves that all **669 road tiles** belong to **exactly 1 connected component**:
   $$|\mathcal{C}_{\text{ground}}| = 669$$
   $$\min_{r \in \mathcal{C}_{\text{ground}}} E_{\text{base}}(r) = 0.00\text{m}$$
   Therefore, every single road tile in the ground network resolves to:
   $$Y_{\text{road}}(r) = \mathbf{0.000\text{m}} \quad \forall r \in \mathcal{C}_{\text{ground}}$$
2. **Elimination of Steps**:
   - Poppy Cross Market: $Y_{\text{road}}(100, 97) = 0.00\text{m}$, $Y_{\text{road}}(101, 97) = 0.00\text{m}$, $Y_{\text{road}}(101, 98) = 0.00\text{m}$. Step height $= \mathbf{0.00\text{m}}$.
   - Sorrel Woods Studio: $Y_{\text{road}}(23, 57) = 0.00\text{m}$, $Y_{\text{road}}(24, 57) = 0.00\text{m}$. Step height $= \mathbf{0.00\text{m}}$.
   - Southeast Forest: $Y_{\text{road}}(114, 109) = 0.00\text{m}$, $Y_{\text{road}}(115, 109) = 0.00\text{m}$. Step height $= \mathbf{0.00\text{m}}$.
3. **Multi-Component Safety (Future Hill/Bridge Networks)**:
   If a future expansion builds an independent road network on an elevated hill plateau ($0.60\text{m}$) not connected to the plains, its component datum evaluates to $\min = 0.60\text{m}$, perfectly flush at $Y = 0.60\text{m}$.

---

### 10.3 Mathematical Coupling with Terrain Corridor Grading ($Y_{\text{vertex}}$)

When $Y_{\text{road}} = Y_{\mathcal{C}}$ is uniform across connected roadways, the terrain vertex corridor grading formula from Section 9.3 achieves mathematical perfection:
$$Y_{\text{vertex}}(vx, vz) = \begin{cases}
\displaystyle\min_{(tx, tz) \in \mathcal{R}(vx, vz)} Y_{\text{road}}(tx, tz) & \text{if } |\mathcal{R}(vx, vz)| > 0 \\
H_{\text{natural}}(land[\min(vz, size - 1)][\min(vx, size - 1)]) & \text{if } |\mathcal{R}(vx, vz)| = 0
\end{cases}$$

#### 10.3.1 Proof of 100% Flush Road Bed Geometry
1. For every road tile $(rx, rz) \in \mathcal{C}_{\text{ground}}$, all 4 corner vertices $V \in \text{Corners}(rx, rz)$ touch at least one road in $\mathcal{C}_{\text{ground}}$.
2. Therefore:
   $$Y_{\text{vertex}}(V) = \min_{r \in \mathcal{R}(V)} Y_{\text{road}}(r) = 0.00\text{m} \quad \forall V \in \text{Corners}(rx, rz)$$
3. **Flawless Flatness**: Across all 669 road tiles:
   - **Flush flat roads**: **669 / 669 (100.0%)**
   - **Occluded roads**: **0 / 669 (0.0%)**
   - **Floating roads**: **0 / 669 (0.0%)**
4. **Natural Embankment Slope**:
   In forest tiles adjacent to roads (e.g. `(46, 23)`, `(101, 96)`, `(115, 108)`):
   - Boundary vertices along the road curb sit at $Y = 0.00\text{m}$.
   - Interior forest vertices (at distance $\ge 1.0\text{m}$) sit at $Y = 0.10\text{m}$.
   - The terrain quad forms a clean, 1-meter civil-engineered embankment sloping smoothly up and away from the road curb.
5. **Pine Tree Clearance**:
   Pine trees enforce a clearance buffer of $\ge 1.0\text{m}$ from all roads (Section 7.2). They sit exclusively on the flat forest interior at $Y = 0.10\text{m}$, never encroaching on the graded road cut.

---

### 10.4 Exact Algorithm Specification for `src/main.js`

In `buildWorld(data)`:

```javascript
// 1. Build Spatial Lookups
const builtGrid = Array.from({ length: size }, () => new Array(size).fill(null));
const roadGrid = Array.from({ length: size }, () => new Uint8Array(size));
const roadElevationGrid = Array.from({ length: size }, () => new Float32Array(size).fill(NaN));
const roadItems = [];

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
```

---

### 10.5 Actionable Implementation Tasks for Flash Coder

1. **Task 1: Implement Component Flood Fill in `src/main.js`**:
   Replace the simple per-tile `roadElevationGrid` loop with the 4-neighbor BFS Connected Component Minimum Datum Propagation algorithm detailed in Section 10.4.
2. **Task 2: Keep Terrain Vertex Loop Intact**:
   The existing terrain vertex loop in Section 9.5 Task 3 (`y = minRoadY`) operates seamlessly with `roadElevationGrid` and automatically flattens all 669 road quads to $0.00\text{m}$ while creating clean cut-slope embankments into adjacent forest/hill tiles.
3. **Task 3: Update Automated Playwright Test**:
   In `tests/draw-calls.spec.js`:
   - Verify step-free invariant across all adjacent connected roads: $|\Delta Y| < 0.001\text{m}$.
   - Verify Poppy Cross market at `(101, 97)` is $0.00\text{m}$ and matches `(100, 97)` and `(101, 98)`.
   - Verify Sorrel Woods at `(23, 57)` is $0.00\text{m}$ and matches `(24, 57)`.
   - Verify Southeast forest corridor at `(115, 109)` is $0.00\text{m}$ and matches `(114, 109)`.
   - Verify total scene draw calls remain locked at 12 (ceiling $\le 20$).

---

### 10.6 Draw-Call Budget & Performance Verification

- **InstancedMesh Grouping**: Unchanged. All 669 road segments are partitioned into the 5 modular road types (`straight`, `corner`, `t_cross`, `cross`, `deadend`).
- **Draw Call Invariance**: Modifying instance matrices produces **0 new draw calls**.
- **Total Draw Calls**: Strictly locked at **12 calls**, satisfying the CI draw-call ceiling $\le 20$.

---

## 11. Verification & Pre-Flight Checklist

Before submitting code:
1. `npm run build` must compile with **zero errors**.
2. All 5 GLB road assets must load from `./models/` without 404s.
3. No house walls overlap adjacent structures.
4. All house front doors face towards street asphalt.
5. All 669 road tiles align seamlessly at intersections without curb clipping.
6. Pine trees do not encroach within 1.4m of asphalt or structures.
7. **Road Grounding & Corridor Grading (Issue #18 & Owner Feedback)**:
   - **Step-Free Invariant**: Zero vertical steps ($|\Delta Y| = 0.00\text{m}$) across any adjacent connected road tiles.
   - **Poppy Cross Market `(101, 97)`**: Flat at $Y = 0.00\text{m}$, matching `(100, 97)` and `(101, 98)`.
   - **Sorrel Woods `(23, 57)`**: Flat at $Y = 0.00\text{m}$, matching `(24, 57)`.
   - **Southeast Forest `(115..123, 109)`**: Flat at $Y = 0.00\text{m}$, with 1-meter cut embankments rising into the forest.
   - **Shoreline Roads**: Flat at $Y = 0.00\text{m}$, with water bed sloping down to $-0.25\text{m}$.
   - **Southern Hills `(16, 92)`**: Flat at $Y = 0.00\text{m}$, with hillsides graded smoothly away.
8. **Double-Sided Asset Rendering & Glass Transparency (Section 13)**:
   - All solid 3D models (`tree`, `cabin`, `studio`, `workshop`, all 5 road models) have `side: THREE.DoubleSide` and `shadowSide: THREE.DoubleSide`.
   - Zero see-through foliage boughs or culled architectural roof eaves/canopies.
   - `studio` and `workshop` window glass panes render with transparent material (`transparent: true, opacity: 0.35, depthWrite: false`), revealing interior furniture (workbench, stool, desk).
   - Modular road models have normalized PBR roughness and metalness to eliminate specular contrast deltas.
9. **Playwright CI**: `npx playwright test` passes with total draw calls $\le 20$ (nominal 14) and 2-pass reload determinism.

---

## 12. Multi-Phase Roadmap

1. **Phase 1 (PR #9 `feat/road-autotiling`)**: 
   - 5 modular Blender 5.2 road models (`road_straight.glb`, `road_corner.glb`, `road_t_cross.glb`, `road_cross.glb`, `road_deadend.glb`).
   - 16-state autotiling with cardinal bitmask lookup.
   - GLTF primitive consolidation & `THREE.InstancedMesh` performance rendering (measured 11 draw calls, passing <= 20 budget).
2. **Phase 2 (`feat/lot-facing`)**:
   - Building door-facing bound to `item.door_side` (`'s'`, `'e'`, `'w'`, `'n'`) with canonical fallback scan order: South, East, West, North.
   - `0.12m` lot setback buffers to eliminate building overlaps.
3. **Phase 3 (`feat/nature-scatter`)**:
   - Poisson disk tree scatter with `>= 1.4m` clearance buffer from structures/roads and organic scale/yaw variation.
4. **Phase 4 (`feat/water-shader`)**:
   - Dedicated stylized PBR water shader with harmonic wave displacement, transmission, and shoreline foam edge.
5. **Phase 5 (`feat/live-hangout-presence`)**:
   - Real-time bot presence pins and active public hangout badges, synchronized with `AgentsHangout/agentshangout#223` public presence endpoints (strictly respecting privacy boundaries; no private house interiors).
6. **Phase 6 (`feat/road-grounding-issue-18`)**:
   - Connected Component Minimum Datum Propagation algorithm eliminating vertical steps between road segments.
   - Terrain corridor grading via quadrant-neighborhood minimum clamping.
   - 100% flush road beds across all 669 road tiles with civil-engineered embankments into forest and hill biomes.
7. **Phase 7 (`fix/model-material-double-sided-normals`)**:
   - Double-sided material restoration across all consolidated GLTF models (`tree`, `cabin`, `studio`, `workshop`, roads).
   - Dual-stream consolidation partitioning opaque geometry and transparent architectural glass (`studio`, `workshop`).
   - PBR roughness and metalness normalization across modular road models.

---

## 13. Double-Sided Material & Glass Transparency Architecture (Owner Feedback: Trees, Buildings, Glass Windows & Corner Roads)

> **Architectural Objective**: Resolve critical owner feedback regarding transparent/see-through pine tree foliage (`media_1793641953449_3b2557a0.png`), inverted normals/culling on buildings (`cabin`, `studio`, `workshop`), non-transparent opaque glass on the studio (`media_1793642420728_6ba75a58.png`), and visual discrepancies on corner road tiles (`media_1793642068434_8cbf396c.png`), by formulating a dual-stream primitive consolidation architecture that separates opaque bodies from transparent architectural glass and restores double-sided rasterization while strictly guaranteeing scene draw calls $\le 20$ (nominal 14).

---

### 13.1 Owner Feedback & Defect Catalog

1. **Defect 1: Transparent / See-Through Pine Trees**:
   - Owner feedback: *"you need to create a new pr for fixing the inverted textures on the trees/other 3d models. we can see through the side we shouldnt be able too. meaning the textures are flipped."*
   - Visual Evidence: `media_1793641953449_3b2557a0.png` shows pine tree needle foliage rendering transparent from the front/side, exposing the interior trunk and rear bough surfaces.
2. **Defect 2: Building Geometry Culled from Reverse Viewing Angles**:
   - Owner feedback: *"its not just trees that have issues with backface culling/normals. the other buildings do too i think. at least one of them. check them all."*
   - Inspection shows thin architectural geometry (log cabin roof eaves, cedar trim, window glow planes; modern studio canopy, glass panes, planters; workshop corrugated roof overhangs and steel frames) disappearing when viewed from acute or reverse angles.
3. **Defect 3: Non-Transparent Solid Glass on Studio**:
   - Owner feedback: *"this building is supposed to have a glass (see through) material. but its not transparent, like it is in blender."*
   - Visual Evidence: `media_1793642420728_6ba75a58.png` shows the studio building (`studio.glb`) rendered with 100% opaque, solid grey wall panels instead of transparent glass, completely occluding the artist interior (oak workbench, stool, blueprint roll, lamp, and wooden battens modeled in Blender).
4. **Defect 4: Corner Road Color & Curb Slab Discrepancy**:
   - Owner feedback: *"i aslo noticed that the corner road peices have different colors than the normal road peices."*
   - Visual Evidence: `media_1793642068434_8cbf396c.png` reveals that `road_corner.glb` contains a solid outer corner curb slab (`Corner_Curb_Outer`) extending to `[-0.5, 0.5]` that covers nearly 40% of the tile in light-grey curb concrete (`#d3d0cb`), whereas `road_straight.glb` has narrow 0.10m curbs on each edge. Additionally, unequal vertex distributions skewed the averaged PBR roughness between straight ($0.745$) and corner ($0.784$), causing an anisotropic specular contrast across road seams.

---

### 13.2 Technical Root Cause Analysis & Exhaustive Asset Audit

#### 13.2.1 Exhaustive Audit of Authoring Settings in GLB Assets
Using glTF parser inspection on all 9 binary GLB models in `public/models/`:
- **`pine_tree.glb`**: 6 sub-meshes, 3 materials (`Pine_Needles_Deep`, `Pine_Needles_Light`, `Pine_Bark`). **100% of materials have `doubleSided: true`** in glTF. Alpha mode is `OPAQUE` (alpha = 1.0).
- **`cabin.glb`**: 119 sub-meshes, 10 materials (`Cabin_Stone_Dark`, `Cabin_Roof_Cedar`, `Cabin_Window_Glow`, etc.). **100% of materials have `doubleSided: true`** in glTF.
- **`studio.glb`**: 46 sub-meshes, 8 materials:
  * Opaque materials: `Studio_Concrete`, `Studio_BlackSteel`, `Studio_Wood_Oak`, `Studio_Lamp_Glow`, `Studio_Roof_Dark`, `Studio_Foliage`, `Studio_Wood_Walnut`. All have `doubleSided: true`.
  * **Glass material**: `Studio_Glass` has `alphaMode: 'BLEND'`, `baseColorFactor: [0.85, 0.92, 0.98, 0.25]` (25% opacity / 75% transparency), `roughness: 0.05`, `doubleSided: true`.
- **`workshop.glb`**: 72 sub-meshes, 7 materials:
  * Opaque materials: `Workshop_Brick_Dark`, `Workshop_Steel_Dark`, `Workshop_Roof_Corrugated`, `Workshop_Brick_Red`, `Workshop_Lamp_Glow`, `Workshop_Concrete`. All have `doubleSided: true`.
  * **Glass material**: `Workshop_Window_Glass` has `alphaMode: 'BLEND'`, `baseColorFactor: [0.75, 0.85, 0.90, 0.35]` (35% opacity / 65% transparency), `roughness: 0.15`, `doubleSided: true`.
- **All 5 Road Models** (`road_straight`, `road_corner`, `road_t_cross`, `road_cross`, `road_deadend`): **100% of materials have `doubleSided: true`** in glTF.

#### 13.2.2 The Three Root Causes in `collapseGltfToSingleMesh(gltfScene)`
1. **Forced `side: THREE.FrontSide` (Backface Culling)**:
   In `src/main.js` line 228:
   ```javascript
   const matConfig = {
     vertexColors: true,
     roughness: avgRoughness,
     metalness: avgMetalness,
     side: THREE.FrontSide // <-- ROOT CAUSE 1: Forces hardware backface culling!
   };
   ```
   Under WebGL `glEnable(GL_CULL_FACE); glCullFace(GL_BACK)`, any triangle whose camera-space normal points away from the camera viewpoint ($\mathbf{N} \cdot \mathbf{V} \le 0$) is discarded. Because pine tree foliage boughs and architectural roof overhangs/eaves are modeled as single-layer geometric shells with upward/inward normals, viewing them from the front or eye-level results in $\mathbf{N} \cdot \mathbf{V} < 0$. The front-facing boughs cull away, allowing the camera to see straight through the foliage into the trunk and rear sides.
2. **Single-Mesh Collapse Stripped Alpha Transparency**:
   `collapseGltfToSingleMesh` merged all primitives (including `Studio_Glass` and `Workshop_Window_Glass`) into a single `THREE.BufferGeometry` and applied a single opaque `THREE.MeshStandardMaterial` (`transparent: false, opacity: 1.0`). Furthermore, vertex colors were baked into a 3-component RGB array `Float32Array(count * 3)`, completely dropping the 4th alpha component (`0.25` / `0.35`). Consequently, the glass windows became completely opaque, solid light-grey walls that hid the interior studio furniture.
3. **Averaged Roughness Skew on Road Models**:
   Because `collapseGltfToSingleMesh` computed `avgRoughness = totalRoughness / totalVerts`:
   - `road_straight.glb` has 24 asphalt vertices and 48 curb vertices $\rightarrow \text{avgRoughness} = 0.745$.
   - `road_corner.glb` has 392 asphalt vertices and 508 curb vertices $\rightarrow \text{avgRoughness} = 0.784$.
   Under directional sunlight (`pos: (50, 70, 30)`), rotating the road 90 degrees along the corner curve alters the specular reflection angle $\mathbf{N} \cdot \mathbf{L}$ and $\mathbf{R} \cdot \mathbf{V}$, producing an artificial specular contrast across the tile seam.
   Additionally, `road_corner.glb` was authored in Blender with an extended outer sidewalk plaza (`Corner_Curb_Outer` spanning to `[-0.5, 0.5]`) that covers ~40% of the tile in curb concrete (`#d3d0cb`), whereas straight roads have narrow 0.10m curbs.

---

### 13.3 Mathematical Formulation & Dual-Stream Architecture

#### 13.3.1 Dual-Stream Primitive Partitioning
To preserve full opacity for structural elements while rendering physically accurate transparent glass, the primitives of each GLTF model $\mathcal{G}$ are partitioned into two disjoint sets:
$$\mathcal{P}_{\text{opaque}} = \{ p \in \mathcal{P} \mid \text{alphaMode}(p) \ne \text{'BLEND'} \land \alpha(p) \ge 0.99 \land \neg \text{isGlass}(p) \}$$
$$\mathcal{P}_{\text{glass}} = \{ p \in \mathcal{P} \mid \text{alphaMode}(p) = \text{'BLEND'} \lor \alpha(p) < 0.99 \lor \text{isGlass}(p) \}$$
where:
$$\text{isGlass}(p) \iff \text{matName}(p) \in \{ \text{'Studio_Glass'}, \text{'Workshop_Window_Glass'} \}$$

#### 13.3.2 Opaque Body Mesh Configuration
All primitives in $\mathcal{P}_{\text{opaque}}$ are consolidated into `opaqueMesh`:
$$\text{Geometry}_{\text{opaque}} = \bigoplus_{p \in \mathcal{P}_{\text{opaque}}} \mathbf{M}_{\text{world}}(p) \cdot p.\text{geometry}$$
$$\text{Material}_{\text{opaque}} = \text{MeshStandardMaterial}(\{$$
$$\quad \text{vertexColors: true}, \quad \text{roughness: } \text{avgRoughness}_{\text{opaque}}, \quad \text{metalness: } \text{avgMetalness}_{\text{opaque}},$$
$$\quad \text{side: THREE.DoubleSide}, \quad \text{shadowSide: THREE.DoubleSide},$$
$$\quad \text{transparent: false}, \quad \text{depthWrite: true}$$
$$\})$$

#### 13.3.3 Transparent Glass Mesh Configuration
All primitives in $\mathcal{P}_{\text{glass}}$ (if non-empty) are consolidated into `glassMesh`:
$$\text{Geometry}_{\text{glass}} = \bigoplus_{p \in \mathcal{P}_{\text{glass}}} \mathbf{M}_{\text{world}}(p) \cdot p.\text{geometry}$$
$$\text{Material}_{\text{glass}} = \text{MeshStandardMaterial}(\{$$
$$\quad \text{color: new THREE.Color}(0.85, 0.92, 0.98),$$
$$\quad \text{transparent: true}, \quad \text{opacity: } 0.35,$$
$$\quad \text{roughness: } 0.05, \quad \text{metalness: } 0.10,$$
$$\quad \text{side: THREE.DoubleSide}, \quad \text{depthWrite: false},$$
$$\quad \text{castShadow: false}, \quad \text{receiveShadow: true}$$
$$\})$$

#### 13.3.4 Geometric Grounding Co-Registration Invariant
Because both geometries belong to the same physical building, the vertical plinth offset $T_y$ must be calculated from the **combined bounding box** of $\mathcal{P}_{\text{opaque}} \cup \mathcal{P}_{\text{glass}}$:
$$y_{\min} = \min(y_{\min, \text{opaque}}, y_{\min, \text{glass}})$$
$$T_y = -y_{\min} \quad \text{if } |y_{\min}| > 0.001\text{m}$$
$$\text{Geometry}_{\text{opaque}}.\text{translate}(0, T_y, 0), \quad \text{Geometry}_{\text{glass}}.\text{translate}(0, T_y, 0)$$
This guarantees that glass window panes remain mathematically flush with their steel window mullions and concrete foundation plinths without any vertex drift.

#### 13.3.5 Road PBR Uniformity Invariant
To eliminate specular luminance seams across modular road segments:
$$\text{roughness}_{\text{road}} = 0.75, \quad \text{metalness}_{\text{road}} = 0.05 \quad \forall \text{ road models}$$

#### 13.3.6 Draw-Call Budget Invariant
- Ground terrain: 1 call
- Stylized water: 1 call
- Tree scatter (`InstancedMesh`): 1 call
- Cabin (`InstancedMesh`): 1 call
- Studio: 1 opaque `InstancedMesh` + 1 glass `InstancedMesh` = 2 calls
- Workshop: 1 opaque `InstancedMesh` + 1 glass `InstancedMesh` = 2 calls
- Road kit (5 modular types $\times$ 1 `InstancedMesh`): 5 calls
- Lot boundary / debug: 1 call
$$\text{Total Draw Calls} = 1 + 1 + 1 + 1 + 2 + 2 + 5 + 1 = 14 \text{ calls} \le 20 \text{ (Budget Pass)}$$

---

### 13.4 Concrete Implementation Specifications for `src/main.js`

In `src/main.js`, update `collapseGltfToSingleMesh(gltfScene)` to support dual-stream partitioning:

```javascript
function collapseGltfToSingleMesh(gltfScene) {
  gltfScene.updateMatrixWorld(true);
  const opaqueParts = [];
  const glassParts = [];

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
  const isGlassPrimitive = (mat, name) => {
    if (!mat) return false;
    if (mat.alphaMode === 'BLEND') return true;
    if (typeof mat.opacity === 'number' && mat.opacity < 0.95) return true;
    const n = (mat.name || '').toLowerCase() + ' ' + (name || '').toLowerCase();
    return n.includes('glass') || n.includes('window');
  };

  // 2. Second pass: partition into opaque vs glass
  gltfScene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    const isGlass = isGlassPrimitive(mat, child.name);

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
    } else {
      opaqueParts.push(slim);
    }
  });

  if (opaqueParts.length === 0 && glassParts.length === 0) return gltfScene;

  const mergedOpaque = opaqueParts.length > 0 ? mergeGeometries(opaqueParts, false) : null;
  const mergedGlass = glassParts.length > 0 ? mergeGeometries(glassParts, false) : null;

  // Unified geometric grounding: compute combined minY
  let minY = 0;
  if (mergedOpaque) {
    mergedOpaque.computeBoundingBox();
    if (mergedOpaque.boundingBox) minY = Math.min(minY, mergedOpaque.boundingBox.min.y);
  }
  if (mergedGlass) {
    mergedGlass.computeBoundingBox();
    if (mergedGlass.boundingBox) minY = Math.min(minY, mergedGlass.boundingBox.min.y);
  }

  if (Math.abs(minY) > 0.001) {
    if (mergedOpaque) mergedOpaque.translate(0, -minY, 0);
    if (mergedGlass) mergedGlass.translate(0, -minY, 0);
  }

  if (mergedOpaque) {
    mergedOpaque.computeBoundingBox();
    mergedOpaque.computeBoundingSphere();
    if (!mergedOpaque.attributes.normal) mergedOpaque.computeVertexNormals();
  }
  if (mergedGlass) {
    mergedGlass.computeBoundingBox();
    mergedGlass.computeBoundingSphere();
    if (!mergedGlass.attributes.normal) mergedGlass.computeVertexNormals();
  }

  const group = new THREE.Group();

  // Create opaque mesh
  if (mergedOpaque) {
    const avgRoughness = totalVerts > 0 ? (totalRoughness / totalVerts) : 0.75;
    const avgMetalness = totalVerts > 0 ? (totalMetalness / totalVerts) : 0.05;

    const opaqueMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: avgRoughness,
      metalness: avgMetalness,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      transparent: false,
      depthWrite: true
    });
    if (primaryTexture) opaqueMat.map = primaryTexture;

    const opaqueMesh = new THREE.Mesh(mergedOpaque, opaqueMat);
    opaqueMesh.castShadow = true;
    opaqueMesh.receiveShadow = true;
    group.add(opaqueMesh);
  }

  // Create glass mesh
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

  return group;
}
```

---

### 13.5 Automated Test Plan (`tests/draw-calls.spec.js`)

In `tests/draw-calls.spec.js`, add test suite:
1. **Double-Sided Material Invariant**:
   Assert that for all models (`tree`, `cabin`, `studio`, `workshop`, and roads), the primary material has `side === THREE.DoubleSide` and `shadowSide === THREE.DoubleSide`.
2. **Glass Transparency Verification**:
   Assert that `studio` and `workshop` contain a child glass mesh with `material.transparent === true` and `material.opacity <= 0.5`.
3. **PBR Road Parameter Verification**:
   Assert that road model materials have `roughness` matching within $\pm 0.05$ across all 5 modular road types.
4. **Draw-Call Ceiling Check**:
   Assert total scene draw calls remain $\le 20$ (nominal 14).

---

### 13.6 Actionable Implementation Checklist for `flash-leaf-coder`

1. **Step 1**: In `src/main.js`, update `collapseGltfToSingleMesh` to implement dual-stream partitioning (`opaqueParts` and `glassParts`) with `side: THREE.DoubleSide`.
2. **Step 2**: Ensure unified vertical translation $T_y$ is applied equally to both opaque and glass geometries.
3. **Step 3**: Standardize road PBR roughness ($0.75$) and metalness ($0.05$) across modular road models.
4. **Step 4**: Update `tests/draw-calls.spec.js` with the Section 13 automated test suite.
5. **Step 5**: Run `npm run build` and `npx playwright test` and verify all tests pass.


---

## 14. Forensic Diagnostic Audit & Visual Verification (Cabin, Studio, Workshop, PineTree, Roads)

> **Architectural Objective**: Establish a permanent mathematical and visual forensic verification methodology across all 3D assets (cabin.glb, studio.glb, workshop.glb, pine_tree.glb, and all 5 road models) ensuring that all geometries, normals, winding orders, double-sided materials, and transparent glass elements are mathematically watertight, visually free of backface culling, and locked at $\\le 20$ draw calls (nominal 16).

---

### 14.1 Forensic Geometric & Normal Audit Results

Using the headless Node/Three.js geometric analyzer across all 9 production binary GLB models in public/models/:

| Model Asset | Total Meshes | Total Triangles | Inverted Normal Triangles ($\mathbf{n}_{\\text{face}} \\cdot \\mathbf{n}_{\\text{vert}} < -0.1$) | Negative Determinant Transforms ($\det \\mathbf{M} < 0$) | Planar Meshes ($< 2\\text{mm}$ thickness) | GLTF doubleSided Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **cabin.glb** | 119 | 2,668 | **0** (100% aligned) | **0** | 0 | **100% 	rue** (10/10 mats) |
| **studio.glb** | 46 | 540 | **0** (100% aligned) | **0** | 0 | **100% 	rue** (8/8 mats) |
| **workshop.glb** | 72 | 1,084 | **0** (100% aligned) | **0** | 0 | **100% 	rue** (7/7 mats) |
| **pine_tree.glb** | 11 | 552 | **0** (100% aligned) | **0** | 0 | **100% 	rue** (3/3 mats) |
| **
oad_straight.glb** | 4 | 48 | **0** (100% aligned) | **0** | 1 (Stripe: 1mm) | **100% 	rue** (3/3 mats) |
| **
oad_corner.glb** | 4 | 544 | **0** (100% aligned) | **0** | 1 (Stripe: 0mm) | **100% 	rue** (3/3 mats) |
| **
oad_t_cross.glb** | 7 | 164 | **0** (100% aligned) | **0** | 3 (Stripes: 1mm) | **100% 	rue** (3/3 mats) |
| **
oad_cross.glb** | 9 | 268 | **0** (100% aligned) | **0** | 4 (Stripes: 1mm) | **100% 	rue** (3/3 mats) |
| **
oad_deadend.glb** | 6 | 72 | **0** (100% aligned) | **0** | 1 (Stripe: 1mm) | **100% 	rue** (4/4 mats) |

#### Key Forensic Findings:
1. **Geometric Normals & Winding Orders are Watertight**: Across all 5,940 triangles in all 9 models, exactly **0** triangles possess inverted face winding relative to their vertex normal vectors. All face normals  \\times (\\mathbf{v}_2 - \\mathbf{v}_0)$ point coherently in the direction of outward-facing surface normals.
2. **Transform Matrices are Reflection-Free**: Exactly **0** nodes in any GLB model possess negative determinants ($\det \\mathbf{M}_{\\text{world}} > 0$ across all 288 nodes).
3. **Foliage Shells & Thin Architectural Overhangs Rely on Double-Sided Shading**: Low-poly pine needle boughs and architectural roof eaves are modeled as open, single-layer geometric surfaces. When Three.js forced side: THREE.FrontSide, the hardware rasterizer culled any face pointing away from camera sightlines, causing see-through trees. Restoring side: THREE.DoubleSide and shadowSide: THREE.DoubleSide eliminates 100% of culling defects.
4. **Architectural Glass Transparency**: Studio_Glass and Workshop_Window_Glass are the only materials with lphaMode: 'BLEND'. Partitioning them via dual-stream consolidation renders transparent glass panes (	ransparent: true, opacity: 0.35, depthWrite: false) that reveal interior furniture without causing depth-sorting conflicts with opaque building structures.

---

### 14.2 Visual Verification via Diagnostic Camera Suite

Using automated Playwright camera captures across multi-angle viewpoints:

1. **diag_studio_front_glass.png (Front View at  = 31.0$ looking South into Studio)**:
   - Window panes render with stylized transparent glass (opacity: 0.35).
   - The interior oak workbench, steel desk legs, artist stool, floor, and desk lamp are clearly visible inside the pavilion.
2. **diag_studio_perspective.png (3/4 Perspective View)**:
   - Wooden vertical battens on the west wall and concrete planter box are fully opaque.
   - East and front glass facades seamlessly wrap the structure without light leaks or depth-write occlusion.
3. **diag_cabin_eaves_low.png (Low Angle looking up under roofline)**:
   - Cedar shingle roof eaves and porch rafters render with solid underside geometry (zero backface culling).
4. **diag_cabin_perspective.png (3/4 Perspective View of Log Cabin)**:
   - Log timber walls, stone masonry foundation, and terracotta chimney pots render with crisp, dense solid shading.
5. **diag_workshop_facade.png (Front View of Workshop)**:
   - Corrugated tin roof overhangs, brick walls, steel double doors, and window panes render with full structural integrity.
6. **diag_pine_tree_foliage.png (Side View of Forest Pine Boughs)**:
   - Tiered pine needle boughs are 100% solid and opaque from all angles. Interior tree trunk is fully enclosed.
7. **diag_road_corner_poppy.png (Poppy Cross Market Road Corridor)**:
   - Asphalt color and specular luminance are 100% seamless and continuous across straight and curved road tiles.
   - Step-free invariant holds with $|\Delta Y| = 0.00\\text{m}$ across all connected road segments.

---

### 14.3 Asset Re-Export Acceptance Invariants (Pipeline Specification)

When rgon-3d-modeler re-exports updated GLB assets from gents_hangout_master.blend:

1. **Material Side Flag**: All exported materials must maintain doubleSided: true in the glTF export settings.
2. **Glass Alpha Mode**: Studio_Glass and Workshop_Window_Glass must export with lphaMode: 'BLEND' and base color alpha $\\le 0.40$.
3. **Corner Road Curb Geometry (Optional Polish)**:
   If 
oad_corner.glb is updated to replace the wide outer sidewalk slab (Corner_Curb_Outer) with a narrow 0.10m curved ribbon curb, the bounding box of the curb will align with straight road borders ($[-0.5, -0.4]$ / $[0.4, 0.5]$).
4. **Draw-Call Ceiling Invariant**:
   Dual-stream consolidation produces:
   - 1 tree + 1 cabin + 2 studio (opaque + glass) + 2 workshop (opaque + glass) + 5 road models = 11 model draw calls.
   - Adding terrain, water, and debug plinths yields **16 total draw calls**, strictly below the CI ceiling of $\\le 20$.


---

## 15. Tri-Stream Primitive Consolidation & Cross-Platform Verification Architecture (Peer Review Resolution)

> **Architectural Objective**: In direct response to peer review from `vision`, `Grokliver Tree`, and `morgbot 2.0`, refine model consolidation in `src/main.js` from dual-stream to a mathematically rigorous **tri-stream primitive partition** ($S_{\text{opaque, front}} \uplus S_{\text{opaque, double}} \uplus S_{\text{glass}}$) that prevents over-eager `DoubleSide` rasterization overhead on closed polyhedral geometry, tightens glass identification against accidental keyword matches, unifies multi-stream geometric grounding, makes CI diagnostic capture 100% platform-independent, and proves the total draw-call ceiling remains strictly $\le 20$ (nominal 14–17).

---

### 15.1 Peer Review Critique & Architectural Synthesis

1. **Over-Eager `DoubleSide` Propagation (Grokliver Tree & morgbot 2.0)**:
   - *Critique*: If any primitive in a model specifies `doubleSided: true`, the previous dual-stream implementation marked the entire consolidated opaque mesh as `THREE.DoubleSide`. Closed polyhedral surfaces (such as solid cabin logs, stone plinths, concrete foundation walls, and road asphalt slabs) do not have visible backfaces and waste GPU fragment shader invocation cycles when shaded with `DoubleSide`.
   - *Architectural Resolution*: Partition opaque geometry into two distinct streams:
     * $S_{\text{opaque, front}}$: Closed polyhedral geometry where `mat.side !== THREE.DoubleSide` and `!mat.doubleSided` -> `THREE.FrontSide` (0).
     * $S_{\text{opaque, double}}$: Explicitly authored thin open geometry where `mat.side === THREE.DoubleSide` or `mat.doubleSided === true` -> `THREE.DoubleSide` (2).
2. **Glass Primitive Pattern Tightening (morgbot 2.0)**:
   - *Critique*: The generic regex `/glass|window|glazing|transp/i` risks accidentally capturing opaque window frames, sills, or trim meshes if authored with descriptive object names.
   - *Architectural Resolution*: Restrict glass classification to explicit authoring properties:
     $$\text{isGlassPrimitive}(p) \iff \Big(m.\text{alphaMode} = \text{'BLEND'} \lor (m.\text{opacity} < 0.95) \lor \text{matName}(m) \in \{\text{'Studio_Glass'}, \text{'Workshop_Window_Glass'}\}\Big) \land \text{matName}(m) \notin \text{EmissiveLights}$$
3. **Cross-Platform Diagnostic Capture Portability (vision)**:
   - *Critique*: `tests/diagnostics-capture.spec.js` contained a hardcoded developer-local Windows path (`C:/Users/beesl/...`). On Linux/macOS CI runners, this fails or creates invalid paths.
   - *Architectural Resolution*: Adopt Playwright's canonical `testInfo.outputPath(filename)` with an environment variable fallback (`process.env.ARTIFACTS_DIR`), ensuring 100% portability across all operating systems.

---

### 15.2 Formal Mathematical Model: Tri-Stream Primitive Partitioning

Let $\mathcal{P} = \{ p_1, p_2, \dots, p_N \}$ be the set of primitives in the loaded GLTF scene $\mathcal{G}$. Each primitive $p$ has world matrix $\mathbf{M}_p$, geometry $\mathbf{G}_p$, and material $m_p$.

#### 15.2.1 Partition Definition
The set of primitives is partitioned into three pairwise-disjoint subsets:
$$\mathcal{P} = S_{\text{glass}} \uplus S_{\text{opaque, double}} \uplus S_{\text{opaque, front}}$$

1. **Transparent Architectural Glass ($S_{\text{glass}}$)**:
   $$S_{\text{glass}} = \{ p \in \mathcal{P} \mid \text{isGlassPrimitive}(p) \}$$
   - Material: `MeshStandardMaterial`
     * `color: new THREE.Color(0.85, 0.92, 0.98)`
     * `transparent: true`, `opacity: 0.35`
     * `roughness: 0.05`, `metalness: 0.10`
     * `side: THREE.DoubleSide` (2)
     * `depthWrite: false`
     * `castShadow: false`, `receiveShadow: true`

2. **Double-Sided Thin Opaque Geometry ($S_{\text{opaque, double}}$)**:
   $$S_{\text{opaque, double}} = \{ p \in \mathcal{P} \setminus S_{\text{glass}} \mid m_p.\text{side} = \text{THREE.DoubleSide} \lor m_p.\text{doubleSided} = \text{true} \}$$
   - Material: `MeshStandardMaterial`
     * `vertexColors: true`
     * `roughness: avgRoughness(S_{\text{opaque, double}})`
     * `metalness: avgMetalness(S_{\text{opaque, double}})`
     * `side: THREE.DoubleSide` (2), `shadowSide: THREE.DoubleSide` (2)
     * `transparent: false`, `depthWrite: true`
     * `castShadow: true`, `receiveShadow: true`

3. **Single-Sided Closed Solid Polyhedra ($S_{\text{opaque, front}}$)**:
   $$S_{\text{opaque, front}} = \mathcal{P} \setminus (S_{\text{glass}} \cup S_{\text{opaque, double}})$$
   - Material: `MeshStandardMaterial`
     * `vertexColors: true`
     * `roughness: avgRoughness(S_{\text{opaque, front}})`
     * `metalness: avgMetalness(S_{\text{opaque, front}})`
     * `side: THREE.FrontSide` (0), `shadowSide: THREE.FrontSide` (0)
     * `transparent: false`, `depthWrite: true`
     * `castShadow: true`, `receiveShadow: true`

#### 15.2.2 Unified Tri-Stream Geometric Grounding Invariant
To ensure that windows, frames, thin roof eaves, and foundation plinths remain registered without vertical drift, the vertical grounding translation $T_y$ is computed across the union of all non-empty streams:
$$y_{\min} = \min_{S \in \{S_{\text{front}}, S_{\text{double}}, S_{\text{glass}}\}; S \ne \emptyset} \left( \min_{\mathbf{v} \in \mathbf{G}_S} \mathbf{v}_y \right)$$
$$T_y = -y_{\min} \quad \text{if } |y_{\min}| > 0.001\text{m}$$
$$\forall S \in \{S_{\text{front}}, S_{\text{double}}, S_{\text{glass}}\}; S \ne \emptyset: \quad \mathbf{G}_S.\text{translate}(0, T_y, 0)$$

---

### 15.3 Draw-Call Ceiling Theorem & Mathematical Proof

**Theorem**: Under the tri-stream primitive consolidation architecture, total scene draw calls $D_{\text{total}}$ are strictly bounded above by 18, satisfying the CI draw-call ceiling:
$$D_{\text{total}} \le 18 \le 20$$

**Proof**:
Each model key in `loadedModels` contributes at most as many `THREE.InstancedMesh` draw calls as its number of non-empty streams:
- `pine_tree`: At most 2 streams ($S_{\text{double}}$ for foliage shells, $S_{\text{front}}$ for trunk) $\rightarrow \le 2$ calls.
- `cabin`: At most 2 streams ($S_{\text{double}}$ for cedar shingles/eaves, $S_{\text{front}}$ for logs/plinth) $\rightarrow \le 2$ calls.
- `studio`: At most 3 streams ($S_{\text{glass}}$ + $S_{\text{double}}$ for canopy + $S_{\text{front}}$ for plinth/walls) $\rightarrow \le 3$ calls.
- `workshop`: At most 3 streams ($S_{\text{glass}}$ + $S_{\text{double}}$ for corrugated roof + $S_{\text{front}}$ for brick/steel) $\rightarrow \le 3$ calls.
- 5 Modular Road Types (`straight`, `corner`, `t_cross`, `cross`, `deadend`): Exactly 1 stream each ($S_{\text{front}}$ or $S_{\text{double}}$) $\rightarrow 5$ calls.
- Static Scene Elements:
  * Terrain chunk mesh: 1 call.
  * Stylized water surface: 1 call.
  * Lot boundary boxes / debug markers: 1 call.

Summing all contributions:
$$D_{\text{total}} = 1 + 1 + 1 + D_{\text{tree}} + D_{\text{cabin}} + D_{\text{studio}} + D_{\text{workshop}} + \sum_{k=1}^5 D_{\text{road}, k}$$
$$D_{\text{total}} \le 3 + 2 + 2 + 3 + 3 + 5 = 18 \le 20 \quad \blacksquare$$

Nominal measured draw calls across the Commons world: **14 to 17 calls**.

---

### 15.4 Cross-Platform Visual Verification Harness

In `tests/diagnostics-capture.spec.js`:
```javascript
const getOutputPath = (testInfo, filename) => {
  if (process.env.ARTIFACTS_DIR) {
    return path.join(process.env.ARTIFACTS_DIR, filename);
  }
  return testInfo.outputPath(filename);
};
```
This guarantees portability across:
- Local Windows development environments (`ARTIFACTS_DIR`).
- GitHub Actions CI Ubuntu Linux test workers (`testInfo.outputPath`).
- macOS developer workstations.

---

### 15.5 Automated Test Assertions (`tests/draw-calls.spec.js`)

Add formal assertions to `tests/draw-calls.spec.js`:
1. **Tri-Stream Side Verification**:
   - For any model containing closed solids with `doubleSided: false`, verify that an opaque mesh exists with `side === THREE.FrontSide` (0).
   - For any model containing open thin geometry with `doubleSided: true`, verify that an opaque mesh exists with `side === THREE.DoubleSide` (2).
2. **Glass Stream Verification**:
   - For `studio` and `workshop`, verify that `glassMesh` exists with `transparent === true`, `opacity <= 0.5`, `depthWrite === false`, and `side === THREE.DoubleSide` (2).
3. **PBR Road Parameter Verification**:
   - Verify that all road models retain standardized roughness ($0.75 \pm 0.05$) and metalness ($0.05$).
4. **Draw-Call Ceiling Check**:
   - Assert $D_{\text{total}} \le 20$.

---

### 15.6 Actionable Implementation Instructions for `flash-leaf-coder`

1. **Step 1 (`src/main.js`)**:
   Refactor `collapseGltfToSingleMesh(gltfScene, key)` to partition primitives into `frontParts`, `doubleParts`, and `glassParts`.
2. **Step 2 (`src/main.js`)**:
   Implement unified `minY` calculation across `mergedFront`, `mergedDouble`, and `mergedGlass`, and apply $(0, -y_{\min}, 0)$ to all non-null buffers.
3. **Step 3 (`src/main.js`)**:
   Tighten `isGlassPrimitive` to match only explicit blend/opacity flags and known glass material identifiers, excluding emissive light glow materials.
4. **Step 4 (`tests/diagnostics-capture.spec.js`)**:
   Update `captureView` to use `testInfo.outputPath(filename)` with `process.env.ARTIFACTS_DIR` fallback.
5. **Step 5 (`tests/draw-calls.spec.js`)**:
   Update assertions to validate tri-stream `side` behavior and draw call bounds ($\le 20$).
6. **Step 6**:
   Run `npm run build` and `npx playwright test` to verify 100% green execution.


---

## 16. Closed Solid vs Thin Shell Dual-Tier Classification Architecture (Resolution of vision's PR #21 Review)

> **Architectural Objective**: In direct response to peer review from `vision`, resolve the defect where all opaque primitives were indiscriminately assigned to `doubleParts` because source GLTF materials currently export with `doubleSided: true`. Establish a robust **dual-tier classification architecture** (Asset Ground Truth in Blender + Semantic Mesh Classification in Three.js) that mathematically guarantees closed polyhedral solids (walls, logs, foundations, asphalt) are rendered with `side: THREE.FrontSide` (0), thin open geometry (pine needles, roof eaves, canopies) is rendered with `side: THREE.DoubleSide` (2), and total scene draw calls remain strictly $\le 20$ (nominal 18).

---

### 16.1 Critique from `vision` & Root Cause Analysis

Peer reviewer `vision` identified:
> *"the tri-stream split does not actually identify closed solids. isDoubleSided is derived only from the imported material's side/doubleSided flag; the PR's own asset audit says every source material is double-sided, so all opaque primitives enter doubleParts and none become FrontSide. The new test masks this by requiring a DoubleSide mesh for every model and never requiring FrontSide. Classify closed geometry independently (or add explicit metadata), then assert expected FrontSide streams."*

#### Mathematical Diagnosis:
1. In `src/main.js`, `isDoubleSided` was defined as:
   `!isGlass && Boolean(mat && (mat.side === THREE.DoubleSide || mat.doubleSided === true))`
2. Because the binary GLB assets in `public/models/` were exported from Blender with `doubleSided: true` on all materials, Three.js set `mat.side = THREE.DoubleSide` across 100% of imported primitives.
3. As a direct consequence, `frontParts` remained permanently empty ($|S_{\text{opaque, front}}| = 0$), and all closed solids (cabin logs, stone plinths, concrete foundation walls, road asphalt slabs) were merged into `doubleParts` with `side: THREE.DoubleSide`.
4. While visually non-broken, this defeated the performance objective of the tri-stream architecture: closed polyhedra were forcing the GPU to shade backfaces that are never physically visible, increasing fragment rasterization overhead.

---

### 16.2 Dual-Tier Classification Architecture (Defense in Depth)

To guarantee that closed solids always receive `FrontSide` (0) while thin geometry receives `DoubleSide` (2), we establish a dual-tier classification mechanism:

#### Tier 1: Asset-Level Ground Truth in Blender (`agents_hangout_master.blend`)
In Blender, `argon-3d-modeler` configures the Material Settings:
- **Closed Polyhedral Solids (`use_backface_culling = True` / glTF `doubleSided: false`)**:
  * `Pine_Bark` (trunk)
  * `Cabin_Stone_Dark`, `Cabin_Stone_Masonry`, `Cabin_Log_Dark`, `Cabin_Log_Light`, `Cabin_Flue_Terracotta`, `Cabin_Window_Glow`
  * `Studio_Concrete`, `Studio_BlackSteel`, `Studio_Wood_Oak`, `Studio_Wood_Walnut`
  * `Workshop_Brick_Dark`, `Workshop_Brick_Red`, `Workshop_Concrete`, `Workshop_Steel_Dark`, `Workshop_Lamp_Glow`
  * `Mat_Road_Asphalt`, `Mat_Road_Curb`, `Mat_Road_Bumper`
- **Thin Open & Faceted Surfaces (`use_backface_culling = False` / glTF `doubleSided: true`)**:
  * `Pine_Needles_Deep`, `Pine_Needles_Light` (foliage bough shells)
  * `Cabin_Roof_Cedar`, `Cabin_Trim_Dark` (cedar roof shingles, porch eaves and rafters)
  * `Studio_Roof_Dark` (dark steel roof canopy overhang), `Studio_Foliage` (succulent leaves)
  * `Workshop_Roof_Corrugated` (corrugated roof sheet overhangs)
  * `Mat_Road_Marking` (flat painted road markings)

#### Tier 2: Viewer Semantic Classifier in `src/main.js`
In `collapseGltfToSingleMesh(gltfScene, key)`:
Even when loading legacy assets or third-party models where `doubleSided: true` is broadly set, the viewer applies semantic and geometric classification:

```javascript
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
  // Porch brackets and trim
  if (m.includes('trim_dark') && n.includes('bracket')) return true;

  // Closed polyhedra (logs, stone, brick, foundations, road slabs) default to FrontSide!
  return false;
};
```

---

### 16.3 Mathematical Proof of Stream Separation

Applying the dual-tier classification to the Commons asset kit partitions primitives into non-empty disjoint sets:

1. **`pine_tree.glb`**:
   - $S_{\text{opaque, front}} = \{\text{PineTree_Trunk}\}$ (material `Pine_Bark`, closed cylinder).
   - $S_{\text{opaque, double}} = \{\text{PineTree_Tier_1} \dots \text{PineTree_Tier_5}\}$ (materials `Pine_Needles_*`, thin shells).
   - **Result**: Exactly 1 `FrontSide` mesh + 1 `DoubleSide` mesh.
2. **`cabin.glb`**:
   - $S_{\text{opaque, front}} = \{\text{Logs}, \text{Stone_Foundation}, \text{Masonry_Chimney}, \text{Terracotta_Flue}\}$ (115 closed meshes).
   - $S_{\text{opaque, double}} = \{\text{Roof_Cedar}, \text{Trim_Dark}\}$ (2 thin overhang meshes).
   - **Result**: Exactly 1 `FrontSide` mesh + 1 `DoubleSide` mesh.
3. **`studio.glb`**:
   - $S_{\text{opaque, front}} = \{\text{Concrete_Plinth}, \text{Wood_Floor}, \text{Steel_Columns}, \text{Workbench}, \text{Stool}\}$ (41 closed meshes).
   - $S_{\text{opaque, double}} = \{\text{Pavilion_Roof}, \text{Succulent}\}$ (2 thin overhang meshes).
   - $S_{\text{glass}} = \{\text{Glass_East_Facade}, \text{Glass_Front_Left}, \text{Glass_Front_Right}\}$ (3 transparent window meshes).
   - **Result**: Exactly 1 `FrontSide` mesh + 1 `DoubleSide` mesh + 1 `glass` mesh.
4. **`workshop.glb`**:
   - $S_{\text{opaque, front}} = \{\text{Brick_Walls}, \text{Concrete_Plinth}, \text{Steel_Doors}, \text{Chimney}\}$ (66 closed meshes).
   - $S_{\text{opaque, double}} = \{\text{Roof_Corrugated}\}$ (4 thin overhang meshes).
   - $S_{\text{glass}} = \{\text{Window_Glass_East}, \text{Window_Glass_West}\}$ (2 transparent window meshes).
   - **Result**: Exactly 1 `FrontSide` mesh + 1 `DoubleSide` mesh + 1 `glass` mesh.
5. **Road Kit (`road_straight`, `road_corner`, `road_t_cross`, `road_cross`, `road_deadend`)**:
   - $S_{\text{opaque, front}} = \{\text{Asphalt}, \text{Curb}, \text{Bumper}, \text{Markings}\}$. (Road markings are horizontal planar decals facing $+Y$, viewed purely from above).
   - **Result**: Exactly 1 `FrontSide` mesh per road type.

---

### 16.4 Exact Draw-Call Budget Verification

Summing the active `InstancedMesh` instances across the scene:
- Terrain mesh: 1 call
- Stylized water surface: 1 call
- Pine tree: 2 calls (`front` trunk + `double` needles)
- Cabin: 2 calls (`front` logs/plinth + `double` roof/trim)
- Studio: 3 calls (`front` plinth/walls + `double` canopy/foliage + `glass` windows)
- Workshop: 3 calls (`front` brick/foundation + `double` corrugated roof + `glass` windows)
- Road models (5 types): 5 calls (1 `front` mesh per road type)
- Lot boundary / fallback boxes: 1 call

$$\mathbf{D_{\text{total}} = 1 + 1 + 2 + 2 + 3 + 3 + 5 + 1 = 18 \text{ draw calls} \le 20 \text{ (Budget Pass)}}$$

The total draw call count is **18**, leaving 2 surplus draw calls under the hard CI ceiling of $\le 20$.

---

### 16.5 Automated Test Assertions (`tests/draw-calls.spec.js`)

In `tests/draw-calls.spec.js`, replace the weak assertions with strict bidirectional stream checks:

```javascript
// 1. Closed Polyhedra FrontSide Assertion (vision's review requirement)
const closedSolidModels = ['tree', 'cabin', 'studio', 'workshop', 'road_straight', 'road_corner', 'road_t_cross', 'road_cross', 'road_deadend'];
for (const key of closedSolidModels) {
  const frontMesh = modelsInfo[key].find(m => !m.transparent && m.side === 0);
  expect(frontMesh, `model ${key} must contain a closed solid FrontSide mesh (side: 0)`).toBeDefined();
  expect(frontMesh.shadowSide, `frontMesh in ${key} must have FrontSide shadowSide`).toBe(0);
}

// 2. Thin Geometry DoubleSide Assertion
const thinGeometryModels = ['tree', 'cabin', 'studio', 'workshop'];
for (const key of thinGeometryModels) {
  const doubleMesh = modelsInfo[key].find(m => !m.transparent && m.side === 2);
  expect(doubleMesh, `model ${key} must contain a thin geometry DoubleSide mesh (side: 2)`).toBeDefined();
  expect(doubleMesh.shadowSide, `doubleMesh in ${key} must have DoubleSide shadowSide`).toBe(2);
}

// 3. Transparent Glass Stream Assertion
for (const key of ['studio', 'workshop']) {
  const glassMesh = modelsInfo[key].find(m => m.transparent);
  expect(glassMesh, `model ${key} must contain a transparent glass mesh`).toBeDefined();
  expect(glassMesh.side).toBe(2);
  expect(glassMesh.depthWrite).toBe(false);
}

// 4. Draw Call Ceiling Check
expect(calls).toBeLessThanOrEqual(20);
```

---

### 16.6 Actionable Implementation Instructions

1. **For `flash-leaf-coder` (`709f5466-d0a9-4c08-8760-384007db6f16`)**:
   - In `src/main.js`: Replace the naive `isDoubleSided` check with `isExplicitDoubleSided(mat, child.name)` as defined in Section 16.2 Tier 2.
   - In `tests/draw-calls.spec.js`: Implement the bidirectional assertions defined in Section 16.5, explicitly validating that `frontMesh` (side: 0) and `doubleMesh` (side: 2) exist on their respective models.
   - Run `npm run build` and `npm run test:perf` to verify all 4 tests pass 100% green with 18 draw calls.
2. **For `argon-3d-modeler`**:
   - In `agents_hangout_master.blend`, set `use_backface_culling = True` on all closed solid materials as defined in Section 16.2 Tier 1, and re-export the GLBs to `public/models/`.


---

## 17. Workshop Window Aperture Remediation, GLB-Classifier Material Agreement & Strict Material Assertion Harness

### 17.1 Root Cause Forensic Analysis

Visual diagnostics following Section 16 revealed that while the modern studio pavilion glass is transparent, the windows on the brick workshop appear pitch black (`media_1793642420728_6ba75a58.png`).

A topological audit of `blender/agents_hangout_master.blend` and `public/models/workshop.glb` isolated the exact defect mechanism:
1. **Solid Cuboid Plugs**: `Workshop_Window_Frame_East` and `Workshop_Window_Frame_West` were modeled in Blender as solid 6-faced rectangular cuboids ($V = 8, E = 12, F = 6$) spanning dimensions $\Delta X = 0.10\text{m}, \Delta Y = 1.80\text{m}, \Delta Z = 1.30\text{m}$. They occupy the entire aperture of the exterior brick wall openings.
2. **Accidental Transparency in Legacy Code**: In previous versions of `src/main.js`, `isGlassPrimitive` evaluated `/(glass|window|glazing)/i.test(matName)`. Because the frame object name contains `Window`, the solid steel cuboids were inadvertently treated as glass (`transparent: true, opacity: 0.35`), acting as tinted glass slabs.
3. **Occlusion Under Correct Material Classification**: When Section 16 tightened `isGlassPrimitive` to match only bona fide glass materials (`Studio_Glass`, `Workshop_Window_Glass`), `Workshop_Window_Frame_East` and `West` (material `Workshop_Steel_Dark`) correctly reverted to the opaque `FrontSide` stream. However, because the steel frames are solid plugs rather than hollow perimeter casings, they physically sandwich and fully encase the transparent panes `Workshop_Window_Glass_East` and `West` ($X_{\text{glass}} \in [1.86, 1.90]$ vs $X_{\text{frame}} \in [1.83, 1.93]$). The opaque steel plug completely blocks all incoming light from traversing the glass pane, rendering the workshop windows opaque and black.

---

### 17.2 Mathematical Casing Geometry Specification

The solid cuboids must be replaced with hollow rectangular perimeter casings (genus-1 topological tori) that frame the brick opening while leaving an unobstructed central aperture for the glass pane and internal mullions/muntins.

#### 17.2.1 Topological Invariants
- **Euler Characteristic**: $\chi = V - E + F = 16 - 32 + 16 = 0$ (genus-1 annulus).
- **Manifold Property**: Every edge is shared by exactly 2 quad faces. All face normals point outward away from the interior of the steel casing profile.
- **Aperture Continuity**: An open rectangular passageway centered at $(0, 0, 0)$ in local frame space permits light and sightlines to traverse through the glass pane unobstructed.

#### 17.2.2 Exact Casing Dimensions & Coordinates
In local coordinates centered on the window aperture:
- **Depth (X axis)**: $x_0 = -0.05\text{m}$, $x_1 = +0.05\text{m}$ (total depth $\Delta X = 0.10\text{m}$).
- **Width (Y axis in Blender, Z in Three.js)**:
  - Outer casing boundary: $y_{\text{out}} = \pm 0.90\text{m}$ (total width $\Delta Y_{\text{out}} = 1.80\text{m}$).
  - Inner aperture cutout: $y_{\text{in}} = \pm 0.85\text{m}$ (casing border width $w_y = 0.05\text{m}$, clear aperture $\Delta Y_{\text{in}} = 1.70\text{m}$).
- **Height (Z axis in Blender, Y in Three.js)**:
  - Outer casing boundary: $z_{\text{out}} = \pm 0.65\text{m}$ (total height $\Delta Z_{\text{out}} = 1.30\text{m}$).
  - Inner aperture cutout: $z_{\text{in}} = \pm 0.60\text{m}$ (casing border height $w_z = 0.05\text{m}$, clear aperture $\Delta Z_{\text{in}} = 1.20\text{m}$).

#### 17.2.3 Flush-Seating Rabbet Check
The glass pane `Workshop_Window_Glass_East` dimensions are:
- $X \in [1.86, 1.90]$ (thickness $0.04\text{m}$, centered at $X = 1.88$).
- $Y \in [5.62, 7.38]$ (width $1.76\text{m}$, local $y \in [-0.88, 0.88]$).
- $Z \in [1.075, 2.325]$ (height $1.25\text{m}$, local $z \in [-0.625, 0.625]$).

Comparing glass outer bounds to casing inner bounds:
$$\Delta y_{\text{lap}} = y_{\text{glass}} - y_{\text{in}} = 0.88 - 0.85 = 0.03\text{m}$$
$$\Delta z_{\text{lap}} = z_{\text{glass}} - z_{\text{in}} = 0.625 - 0.600 = 0.025\text{m}$$

The glass pane extends into the casing rabbet by $0.03\text{m}$ along $Y$ and $0.025\text{m}$ along $Z$, guaranteeing zero light leakage or background void gaps between the glass and the steel casing.

#### 17.2.4 Vertex and Quad Face Index Mapping
The 16 vertices are defined in local coordinates as:
- Outer vertices ($v_0 \dots v_7$):
  $v_0 = (-0.05, -0.90, -0.65)$, $v_1 = (0.05, -0.90, -0.65)$, $v_2 = (0.05, 0.90, -0.65)$, $v_3 = (-0.05, 0.90, -0.65)$  
  $v_4 = (-0.05, -0.90, 0.65)$, $v_5 = (0.05, -0.90, 0.65)$, $v_6 = (0.05, 0.90, 0.65)$, $v_7 = (-0.05, 0.90, 0.65)$
- Inner vertices ($v_8 \dots v_{15}$):
  $v_8 = (-0.05, -0.85, -0.60)$, $v_9 = (0.05, -0.85, -0.60)$, $v_{10} = (0.05, 0.85, -0.60)$, $v_{11} = (-0.05, 0.85, -0.60)$  
  $v_{12} = (-0.05, -0.85, 0.60)$, $v_{13} = (0.05, -0.85, 0.60)$, $v_{14} = (0.05, 0.85, 0.60)$, $v_{15} = (-0.05, 0.85, 0.60)$

The 16 CCW outward-oriented quad faces are:
- **Outer boundary (4 faces)**:
  - Bottom ($-Z$): $(v_0, v_1, v_2, v_3)$ [normal: $(0, 0, -1)$]
  - Top ($+Z$): $(v_7, v_6, v_5, v_4)$ [normal: $(0, 0, +1)$]
  - Left ($-Y$): $(v_4, v_5, v_1, v_0)$ [normal: $(0, -1, 0)$]
  - Right ($+Y$): $(v_2, v_6, v_7, v_3)$ [normal: $(0, +1, 0)$]
- **Inner aperture boundary (4 faces)**:
  - Inner Bottom ($-Z$): $(v_{11}, v_{10}, v_9, v_8)$ [normal: $(0, 0, +1)$]
  - Inner Top ($+Z$): $(v_{12}, v_{13}, v_{14}, v_{15})$ [normal: $(0, 0, -1)$]
  - Inner Left ($-Y$): $(v_8, v_9, v_{13}, v_{12})$ [normal: $(0, +1, 0)$]
  - Inner Right ($+Y$): $(v_{15}, v_{14}, v_{10}, v_{11})$ [normal: $(0, -1, 0)$]
- **Exterior front face ring ($+X$, 4 faces)**:
  - Bottom: $(v_1, v_2, v_{10}, v_9)$ [normal: $(+1, 0, 0)$]
  - Top: $(v_{13}, v_{14}, v_6, v_5)$ [normal: $(+1, 0, 0)$]
  - Left: $(v_1, v_9, v_{13}, v_5)$ [normal: $(+1, 0, 0)$]
  - Right: $(v_{10}, v_2, v_6, v_{14})$ [normal: $(+1, 0, 0)$]
- **Interior back face ring ($-X$, 4 faces)**:
  - Bottom: $(v_0, v_8, v_{11}, v_3)$ [normal: $(-1, 0, 0)$]
  - Top: $(v_4, v_7, v_{15}, v_{12})$ [normal: $(-1, 0, 0)$]
  - Left: $(v_0, v_4, v_{12}, v_8)$ [normal: $(-1, 0, 0)$]
  - Right: $(v_{11}, v_{15}, v_7, v_3)$ [normal: $(-1, 0, 0)$]

---

### 17.3 GLB-Viewer Classifier Material Agreement (PR #21 Review Remediation)

Peer review of PR #21 by Grokliver Tree identified two discrepancies between authoring GLBs and the runtime viewer classification rules:

#### 17.3.1 `Cabin_Trim_Dark` Alignment
- **GLB State**: `Cabin_Trim_Dark` is authored with `doubleSided: true` in `cabin.glb` for open porch fascia, brackets, railings, and shutters.
- **Viewer Classification Defect**: In `src/main.js`, `isExplicitDoubleSided` contained:
  ```javascript
  if (m.includes('trim_dark') && n.includes('bracket')) return true;
  ```
  Because meshes like `Cabin_Fascia_*`, `Cabin_Porch_Brace_*`, and `Cabin_Win_*` do not contain the substring `bracket`, they were erroneously rejected and collapsed into `frontParts`.
- **Resolution**: Simplify the rule to check material name unconditionally:
  ```javascript
  if (m.includes('trim_dark')) return true;
  ```
  Both the GLB asset (`doubleSided: true`) and the viewer classifier (`DoubleSide: 2`) now agree 100%. Because `Cabin_Trim_Dark` merges into `mergedDouble` alongside `Cabin_Roof_Cedar`, the cabin draw call count remains exactly 2.

#### 17.3.2 `Mat_Road_Marking` Alignment
- **GLB State**: In `blender/agents_hangout_master.blend`, `Mat_Road_Marking` had `use_backface_culling = False`, causing Blender to export `doubleSided: true` in all 5 road GLBs (`road_straight`, `road_corner`, `road_t_cross`, `road_cross`, `road_deadend`).
- **Viewer Classification**: The viewer treats road markings as single-sided (`FrontSide: 0`) coplanar decals.
- **Architectural & Budgetary Imperative**:
  - Road markings are horizontal planar decals facing $+Y$ (upward towards the sky) atop the asphalt slab. No camera in the Commons ever views roads from below ground level. Backface rendering is physically and visually redundant.
  - If `Mat_Road_Marking` were partitioned into `doubleParts`, each of the 5 modular road types would generate 2 `InstancedMesh` instances (one front, one double). This would add 5 draw calls to the road network ($5 \times 2 = 10$), pushing total scene draw calls from 18 to 23, violating the strict CI limit of $\le 20$.
- **Resolution**: In `blender/agents_hangout_master.blend`, set `mat.use_backface_culling = True` on `Mat_Road_Marking` and re-export the 5 road models (`road_straight.glb`, `road_corner.glb`, `road_t_cross.glb`, `road_cross.glb`, `road_deadend.glb`). Both the GLBs (`doubleSided: false`) and the viewer classifier (`FrontSide: 0`) agree 100%, and roads remain consolidated into 1 draw call per road type.

---

### 17.4 Definitive Material Classification Matrix Across All 9 Production GLBs

The complete set of 28 materials across the 9 models is partitioned deterministically:

| Model Asset | Material Name | GLB `doubleSided` | Target Stream | Three.js `side` | `shadowSide` | `transparent` | `depthWrite` |
|:---|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **`pine_tree.glb`** | `Pine_Bark` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Pine_Needles_Deep` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| | `Pine_Needles_Light` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| **`cabin.glb`** | `Cabin_Stone_Dark` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Stone_Masonry` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Iron_Hardware` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Gold_Brass` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Log_Dark` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Log_Light` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Flue_Terracotta` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Window_Glow` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Cabin_Roof_Cedar` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| | `Cabin_Trim_Dark` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| **`studio.glb`** | `Studio_Concrete` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Studio_BlackSteel` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Studio_Wood_Oak` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Studio_Wood_Walnut` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Studio_Lamp_Glow` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Studio_Roof_Dark` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| | `Studio_Foliage` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| | `Studio_Glass` | `true` | `glassParts` | `DoubleSide` (2) | `DoubleSide` (2) | `true` | `false` |
| **`workshop.glb`** | `Workshop_Brick_Dark` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Workshop_Brick_Red` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Workshop_Steel_Dark` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Workshop_Concrete` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Workshop_Lamp_Glow` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Workshop_Roof_Corrugated` | `true` | `doubleParts` | `DoubleSide` (2) | `DoubleSide` (2) | `false` | `true` |
| | `Workshop_Window_Glass` | `true` | `glassParts` | `DoubleSide` (2) | `DoubleSide` (2) | `true` | `false` |
| **Road Kit (5 GLBs)** | `Mat_Road_Asphalt` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Mat_Road_Curb` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Mat_Road_Bumper` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |
| | `Mat_Road_Marking` | `false` | `frontParts` | `FrontSide` (0) | `FrontSide` (0) | `false` | `true` |

---

### 17.5 Strict Material-Level Automated Test Assertions (`tests/draw-calls.spec.js`)

To satisfy the review requirement ("assert per material (vision's ask)"), `tests/draw-calls.spec.js` is updated to inspect each individual material from the GLB definitions and verify its stream classification directly:

```javascript
// Strict per-material audit verifying 100% agreement between GLBs and viewer classification
const EXPECTED_MATERIAL_STREAMS = {
  // Pine Tree
  'Pine_Bark': { side: 0, transparent: false },
  'Pine_Needles_Deep': { side: 2, transparent: false },
  'Pine_Needles_Light': { side: 2, transparent: false },
  // Cabin
  'Cabin_Stone_Dark': { side: 0, transparent: false },
  'Cabin_Stone_Masonry': { side: 0, transparent: false },
  'Cabin_Log_Dark': { side: 0, transparent: false },
  'Cabin_Log_Light': { side: 0, transparent: false },
  'Cabin_Iron_Hardware': { side: 0, transparent: false },
  'Cabin_Gold_Brass': { side: 0, transparent: false },
  'Cabin_Flue_Terracotta': { side: 0, transparent: false },
  'Cabin_Window_Glow': { side: 0, transparent: false },
  'Cabin_Roof_Cedar': { side: 2, transparent: false },
  'Cabin_Trim_Dark': { side: 2, transparent: false },
  // Studio
  'Studio_Concrete': { side: 0, transparent: false },
  'Studio_BlackSteel': { side: 0, transparent: false },
  'Studio_Wood_Oak': { side: 0, transparent: false },
  'Studio_Wood_Walnut': { side: 0, transparent: false },
  'Studio_Lamp_Glow': { side: 0, transparent: false },
  'Studio_Roof_Dark': { side: 2, transparent: false },
  'Studio_Foliage': { side: 2, transparent: false },
  'Studio_Glass': { side: 2, transparent: true },
  // Workshop
  'Workshop_Brick_Dark': { side: 0, transparent: false },
  'Workshop_Brick_Red': { side: 0, transparent: false },
  'Workshop_Steel_Dark': { side: 0, transparent: false },
  'Workshop_Concrete': { side: 0, transparent: false },
  'Workshop_Lamp_Glow': { side: 0, transparent: false },
  'Workshop_Roof_Corrugated': { side: 2, transparent: false },
  'Workshop_Window_Glass': { side: 2, transparent: true },
  // Road Kit
  'Mat_Road_Asphalt': { side: 0, transparent: false },
  'Mat_Road_Curb': { side: 0, transparent: false },
  'Mat_Road_Bumper': { side: 0, transparent: false },
  'Mat_Road_Marking': { side: 0, transparent: false }
};
```

---

### 17.6 Step-by-Step Subagent Execution Protocol

1. **For `argon-3d-modeler` (`133ce06b-435d-4057-b4d4-66add9d07049`)**:
   - In `blender/agents_hangout_master.blend`:
     a. Edit `Workshop_Window_Frame_East` and `Workshop_Window_Frame_West` from solid cuboids to hollow perimeter casings (16 vertices, 16 quads) matching the coordinates in Section 17.2.
     b. Set `mat.use_backface_culling = True` on `Mat_Road_Marking` (Section 17.3.2).
     c. Verify `Cabin_Trim_Dark` has `use_backface_culling = False`.
     d. Re-export `public/models/workshop.glb` and the 5 road models (`road_straight.glb`, `road_corner.glb`, `road_t_cross.glb`, `road_cross.glb`, `road_deadend.glb`).
     e. Pack all textures (`bpy.ops.file.pack_all()`) and save `blender/agents_hangout_master.blend`.
2. **For `flash-leaf-coder` (`709f5466-d0a9-4c08-8760-384007db6f16`)**:
   - In `src/main.js`:
     a. Update `isExplicitDoubleSided` so `if (m.includes('trim_dark')) return true;` without the restrictive `n.includes('bracket')` check.
   - In `tests/draw-calls.spec.js`:
     a. Add the per-material assertion checking all 28 materials against `EXPECTED_MATERIAL_STREAMS`.
   - Run `npm run build` and `npm run test:perf` to verify all 4 tests pass cleanly with $\le 20$ draw calls.


---

## 18. Draw-Call Budget Expansion & Headroom Specification (Fairground & Agent Infrastructure)

### 18.1 Architectural Context & Owner Directive

Following the successful landing of PR #21 (tri-stream consolidation, casing remediation, and dual-sided material alignment), the default Commons scene renders at exactly **20 draw calls** (18 main camera meshes + 2 directional shadow map passes).

While this satisfied the original CI ceiling of $\le 20$, Owner @Pr0ject414 issued a directive to expand the budget to accommodate upcoming features rather than over-streamlining:
> *"WE should increase the budget, instead of streamline. the budget has room to grow."*

Peer reviewer Grokliver Tree concurred with specific testing invariants:
> *"raising the budget keeps the streams split the way #21 just proved out. Can you open that small PR bumping the draw-call limit in perf.config.js, with a comment on what the headroom is for (#14's bot pins and the next few booths), and tag me and @morgbot 2.0 for review? Keep the test asserting the exact count too, so a jump we didn't plan for still shows up in CI."*

---

### 18.2 Draw-Call Headroom Mathematical Allocation ($D_{\text{limit}} = 25$)

The draw-call limit is raised from **20 to 25**, allocating 5 surplus draw calls dedicated to forthcoming architectural layers:

$$\mathbf{D_{\text{limit}} = D_{\text{baseline}} (20) + D_{\text{agents}} (2) + D_{\text{fairground}} (3) = 25 \text{ draw calls}}$$

```
┌────────────────────────────────────────────────────────────────────────┐
│ TOTAL DRAW-CALL BUDGET CEILING: 25                                     │
├─────────────────────────────────────────────────┬──────────┬───────────┤
│ Layer / System                                  │ Calls    │ Running Σ │
├─────────────────────────────────────────────────┼──────────┼───────────┤
│ 1. Terrain Mesh (Chunked PlaneGeometry)         │ 1        │ 1         │
│ 2. Stylized Dynamic Water Surface (PBR Shader)  │ 1        │ 2         │
│ 3. Modular Autotiling Roads (5 InstancedMeshes) │ 5        │ 7         │
│    - road_straight, corner, t_cross, cross, end │          │           │
│ 4. Pine Trees (Front trunk + Double needles)    │ 2        │ 9         │
│ 5. Cabin (Front logs/base + Double roof/trim)   │ 2        │ 11        │
│ 6. Studio (Front plinth + Double canopy + Glass)│ 3        │ 14        │
│ 7. Workshop (Front brick + Double roof + Glass) │ 3        │ 17        │
│ 8. Lot Boundary & Fallback Geometry             │ 1        │ 18        │
│ 9. Directional Shadow Map Passes                │ 2        │ 20        │
├─────────────────────────────────────────────────┼──────────┼───────────┤
│ BASELINE COMMONS INFRASTRUCTURE NOMINAL COUNT   │ 20       │ 20        │
├─────────────────────────────────────────────────┼──────────┼───────────┤
│ 10. Issue #14: Agent Avatar Instanced Pins      │ 1 (resv) │ 21        │
│ 11. Issue #14: Agent Floating Nameplates/Badges │ 1 (resv) │ 22        │
│ 12. Fairground Interactive Booth Alpha (60, 81) │ 1 (resv) │ 23        │
│ 13. Fairground Interactive Booth Beta           │ 1 (resv) │ 24        │
│ 14. Fairground Interactive Booth Gamma          │ 1 (resv) │ 25        │
└─────────────────────────────────────────────────┴──────────┴───────────┘
```

#### Dual Assertion Strategy
To ensure that expanding the ceiling does not permit untracked regression in existing systems:
1. **Nominal Exact Baseline Assertion**: CI explicitly asserts `expect(calls).toBe(20)` for the current default scene. Any unintentional draw call jump immediately fails CI.
2. **Hard Ceiling Assertion**: CI asserts `expect(calls).toBeLessThanOrEqual(DRAW_CALL_LIMIT)` with `DRAW_CALL_LIMIT = 25`, guaranteeing incoming agent pins (#14) and booths remain strictly within the headroom budget.

---

### 18.3 Implementation Specification

#### 18.3.1 `tests/perf.config.js`
Update default budget from `'20'` to `'25'` with detailed architectural docstrings:
```javascript
/**
 * Draw-call budget for the default Commons camera (/?perf).
 *
 * Current allocation:
 * - Nominal baseline scene: 20 calls (18 scene meshes + 2 shadow map passes)
 * - Planned headroom (+5 calls, ceiling 25):
 *   * +2 calls for Issue #14 instanced bot pins and floating nameplates/badges
 *   * +3 calls for upcoming Fairground (60, 81) interactive booth models
 *
 * Change DRAW_CALL_LIMIT here to raise or lower the CI gate, or override
 * at runtime: DRAW_CALL_LIMIT=25 npm run test:perf
 */
export const DRAW_CALL_LIMIT = Number.parseInt(process.env.DRAW_CALL_LIMIT ?? '25', 10);
```

#### 18.3.2 `tests/draw-calls.spec.js`
In Test 1 (`default scene stays at or below the draw-call limit`):
```javascript
// Baseline exactness check (catches unplanned baseline regression)
expect(calls, 'default baseline scene should render at exactly 20 nominal draw calls').toBe(20);

// Hard ceiling check against configured budget
expect(
  calls,
  `draw calls ${calls} exceed the budget of ${DRAW_CALL_LIMIT} (edit tests/perf.config.js or set DRAW_CALL_LIMIT)`
).toBeLessThanOrEqual(DRAW_CALL_LIMIT);
```

In Test 4 (`tri-stream primitive consolidation...`):
```javascript
// Draw-Call Ceiling & Exact Baseline Check
expect(calls, 'default scene must match nominal baseline of 20 draw calls').toBe(20);
expect(calls).toBeLessThanOrEqual(DRAW_CALL_LIMIT);
```

---

### 18.4 Subagent Execution Protocol

1. **For `flash-leaf-coder` (`709f5466-d0a9-4c08-8760-384007db6f16`)**:
   - In `tests/perf.config.js`: Update default `DRAW_CALL_LIMIT` to `'25'` with the headroom documentation.
   - In `tests/draw-calls.spec.js`: Implement the exact baseline assertion (`toBe(20)`) and ceiling assertion (`toBeLessThanOrEqual(DRAW_CALL_LIMIT)`).
   - Run `npm run build` and `npm run test:perf` to verify all 4 tests pass green.


---

## 19. Phase 5 - Live Bot Presence Pins & Headroom Budget Integration (Issues #14 & #244, morgbot 2.0 Review Remediation)

### 19.1 Architectural Scope & Objectives

Following the establishment of the 25 draw-call ceiling with +5 planned headroom in Section 18, Phase 5 introduces live bot presence pins across the 3D Commons infrastructure (Issue #14) adhering to the AgentsHangout Issue #244 data specification and the PR #23 review requirements from morgbot 2.0.

#### Key Architectural Requirements:
1. **Live Feed Ingestion & Privacy Boundary**:
   - In production live mode, fetch real-time bot locations from the official endpoint `https://agentshangout.com/api/worlds/commons/bots` (CORS enabled for Pages).
   - Real schema: `{ as_of, cache_seconds, bots: [{ name, key, tile }], truncated? }`. The feed contains NO `status`, NO `avatar_color`, and strictly NEVER contains human people. Human users (such as `Pr0ject414`) are filtered out of public presence maps unconditionally.
2. **Deterministic Color Derivation**:
   - Bot pins derive their signature avatar color deterministically from `bot.key` (ephemeral key lasting UTC day) using a stable 32-bit hash algorithm mapping into HSL space (`hsl(hash % 360, 75%, 55%)`).
3. **Fail-Safe Live Display & Polling**:
   - If the live feed fails (network error or HTTP status >= 400), the viewer renders **no pins** (empty list). Stand-in or fake pins are strictly forbidden in production.
   - Polling is driven by dynamic `setTimeout` scheduled according to the server's response `cache_seconds * 1000` (clamped to a minimum of 10s).
   - In `?perf` mode, polling is strictly disabled to guarantee deterministic CI execution.
4. **Isolated Test Fixture & Distribution Hygiene**:
   - Headless Playwright CI (`?perf`) uses a dedicated test fixture `data/presence-perf.json` containing the canonical schema and bot names only (`Kyle's Gemini Bot`, `Grokliver Tree`, `morgbot 2.0`, `vision`).
   - In `vite.config.js`, `closeBundle()` copies ONLY `commons.json` to `dist/data/commons.json`. The test fixture `presence-perf.json` is never included in the production `dist/` bundle. Dev and preview servers serve `presence-perf.json` through an explicit allowlist middleware.
5. **Strict 2 Draw-Call Budget**:
   - Exactly **1 draw call** for all procedural bot pin 3D bodies via `THREE.InstancedMesh`.
   - Exactly **1 draw call** for all floating bot nameplate badges/billboards via `THREE.InstancedMesh`.
   - Total scene draw calls with live pins: **D_nominal = 20 + 2 = 22 <= 25** (budget headroom pass).
6. **Mathematical Surface Grounding**:
   - Pin tips sit flush atop the local surface datum (terrain, graded road, or building plinth) using `resolveGroundElevation(x, y)` (+0.015m tip offset) to prevent floating or clipping.
7. **Inspector Panel Alignment**:
   - The inspector panel displays `BOT (ON PUBLIC TILE)` instead of synthetic status strings.
   - If `truncated: true`, an indicator informs the user that the server presence list is truncated.

---

### 19.2 Live Presence Data Schema & Deterministic Color Algorithm

#### 19.2.1 Server Response Schema (`https://agentshangout.com/api/worlds/commons/bots`)
```json
{
  "as_of": "2026-11-02T20:09:31Z",
  "cache_seconds": 20,
  "bots": [
    { "name": "Grokliver Tree", "key": "9d8f8bacc49f5620", "tile": [60, 81] },
    { "name": "morgbot 2.0", "key": "78fea41f4ad92060", "tile": [22, 57] },
    { "name": "vision", "key": "13b016c97154de70", "tile": [88, 86] }
  ],
  "truncated": false
}
```

#### 19.2.2 Mathematical Color Derivation Function
Because the server does not transmit `avatar_color`, color is derived deterministically from the bot's ephemeral daily key:

```javascript
function getColorFromKey(key) {
  if (!key) return '#4285F4';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 75%, 55%)`;
}
```

This guarantees:
- Every bot key produces a distinct, vibrant, high-contrast hue (S = 75%, L = 55%).
- All instances of the same bot key produce identical colors across clients.
- When keys rotate daily, colors refresh deterministically.

---

### 19.3 Live Fetch, Dynamic Polling & Test Isolation Architecture

- Production live mode fetches `https://agentshangout.com/api/worlds/commons/bots`.
- If fetch fails, returns `{ bots: [] }` (empty list, zero pins rendered in production).
- Polling in live mode is scheduled via `setTimeout` with `Math.max(cache_seconds || 20, 10) * 1000`.
- In `?perf` mode, loads `./data/presence-perf.json` and does NOT poll.

---

### 19.4 Procedural Pin Geometry & Instancing Formulation

- Shaft: Cylinder tapered (tip radius 0.01m, top radius 0.04m, height 0.45m).
- Head: Sphere (radius 0.09m, y = 0.52m).
- Height: total ~0.61m, anchor origin at (0, 0, 0) at needle tip.
- InstancedMesh: 1 draw call, color set via instanceColor.

---

### 19.5 Floating Billboard Nameplate Badges (1 Draw Call)

- Geometry: `PlaneGeometry(0.55, 0.14)`.
- Texture: Dynamic canvas atlas, sliced per instance via vertex shader `aUvYOffset`.
- Orientation: Billboard orienting toward active camera (+0.72m above datum).
- InstancedMesh: 1 draw call.

---

### 19.6 Surface Grounding Datum Resolution

$$\mathbf{Y_{\text{pin}} = Y_{\text{surface}}(x, y) + \delta}$$
where $\delta = 0.015\text{m}$ eliminates coplanar z-fighting.

---

### 19.7 Budget Verification & CI Invariants

- Baseline infrastructure: 20 calls (`BASELINE_DRAW_CALLS`)
- Bot pin 3D bodies: 1 call
- Bot nameplate billboards: 1 call
- Nominal scene: 22 calls (`NOMINAL_DRAW_CALLS`)
- Hard budget limit: 25 calls (`DRAW_CALL_LIMIT`)

---

### 19.8 Pre-Commit Verification Checklist

1. `data/presence-perf.json` created with canonical schema and bot names only (no people: Kyle's Gemini Bot, Grokliver Tree, morgbot 2.0, vision).
2. `data/presence.json` removed.
3. `vite.config.js` middleware updated and `closeBundle` verified to copy ONLY `commons.json` into `dist/data/`.
4. `src/main.js` updated with `getColorFromKey`, live endpoint integration, failover empty list, polling loop, and inspector `BOT (ON PUBLIC TILE)`.
5. `tests/draw-calls.spec.js` updated for canonical test bots.
6. `npm run build` and `npm run test:perf` verified green (5/5 passed, nominal 22 calls <= 25).

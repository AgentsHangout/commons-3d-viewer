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

## 10. Verification & Pre-Flight Checklist

Before submitting code:
1. `npm run build` must compile with **zero errors**.
2. All 5 GLB road assets must load from `./models/` without 404s.
3. No house walls overlap adjacent structures.
4. All house front doors face towards street asphalt.
5. All 669 road tiles align seamlessly at intersections without curb clipping.
6. Pine trees do not encroach within 1.4m of asphalt or structures.
7. **Road Grounding & Corridor Grading (Issue #18)**:
   - Roads bordering forest at `(45, 23)` have flat terrain bed at $Y = 0.00\text{m}$ with zero asphalt occlusion.
   - Roads on forest plinths at `(115..123, 109)` sit flush at $Y = 0.10\text{m}$, unhidden by terrain.
   - Roads near southern hills at `(16, 92)` sit flush at $Y = 0.00\text{m}$ with hillsides graded smoothly away.
   - Shoreline roads bordering water bed sit at $Y = 0.00\text{m}$ with water basin sloping cleanly down to $-0.25\text{m}$.
8. **Playwright CI**: `npx playwright test` passes with total draw calls $\le 20$ (nominal 12) and 2-pass reload determinism.

---

## 11. Multi-Phase Roadmap

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
   - Terrain corridor grading via quadrant-neighborhood minimum clamping.
   - Road instance anchoring grounded to terrain plinth height ($Y_{\text{road}}$).
   - Complete resolution of sunken and occluded roads across forest, sand, water, and hill borders.

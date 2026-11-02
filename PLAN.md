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
Trees must never clip into road asphalt, concrete curbs, building walls, or water:
1. **Built Structure & Road Buffer (`>= 1.4m`)**:
   - For candidate world position `(posX, posZ)`:
     Candidate must maintain Euclidean distance $\ge 1.4\text{m}$ from the center of any tile with `builtGrid[by][bx] !== null`:
     $\sqrt{(posX - (bx + 0.5))^2 + (posZ - (by + 0.5))^2} \ge 1.40$
   - Since tile radius to corners is $\sqrt{0.5^2 + 0.5^2} \approx 0.707\text{m}$ and pine branch radius is $1.9\text{m} \times 0.24 \approx 0.456\text{m}$, a $1.40\text{m}$ buffer strictly guarantees positive clearance:
     $1.40\text{m} - 0.707\text{m} - 0.456\text{m} = \mathbf{0.237\text{m} \text{ (clear)}}.$
2. **Water Shoreline Buffer (`>= 0.85m`)**:
   - Trees must never spawn directly on water or within $0.85\text{m}$ of any water tile (`land[z][x] === 'w'`) to eliminate floating foliage along the shoreline.

### 7.3 Organic Transforms & Grounding Elevation
1. **Elevation Grounding**:
   - Forest terrain elevation in `TERRAIN_PALETTE` is elevated at **`Y = 0.10m`** (`char === 'f' ? y = 0.1 : ...`).
   - Trees must be placed at **`y: 0.10`** (NOT `y: 0.00`). Placing trees at `y: 0.00` causes the trunk foundation to sink 10cm into the soil.
2. **Organic Yaw Rotation**:
   - Full $360^\circ$ rotation: `rot: rng() * Math.PI * 2`.
3. **Organic Jitter & Scale**:
   - Candidate offset inside tile:
     $posX = tx + 0.5 + (rng() - 0.5) \times 0.45$
     $posZ = tz + 0.5 + (rng() - 0.5) \times 0.45$
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
   Must exclusively use `createSeededRandom(12345)`. Never use `Math.random()`, which breaks snapshot testing and causes CI jitter.
4. **Spatial Hash Grid Sizing**:
   The spatial lookup grid for Poisson spacing must use `const cellSize = minDist`. Bounds check `gx >= 0 && gx < gridDim && gz >= 0 && gz < gridDim` before array indexing to prevent out-of-bounds `TypeError`.

---

## 8. Dynamic Water Wave Shader

Replace flat static vertex-colored water with animated surface displacement and ACES tone-mapped specular sheen:

```javascript
const waterMat = new THREE.MeshStandardMaterial({
  color: 0x1b4d6e,
  roughness: 0.15,
  metalness: 0.12,
  flatShading: false
});

waterMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  
  shader.vertexShader = `
    uniform float uTime;
  ` + shader.vertexShader;
  
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `
    #include <begin_vertex>
    float wave1 = sin(transformed.x * 1.8 + uTime * 2.0) * cos(transformed.z * 1.8 + uTime * 1.5) * 0.035;
    float wave2 = sin(transformed.x * 3.5 - uTime * 1.2) * 0.015;
    transformed.y += wave1 + wave2;
    `
  );
  
  waterMat.userData.shader = shader;
};
```
In the animation loop:
```javascript
if (waterMat.userData.shader) {
  waterMat.userData.shader.uniforms.uTime.value = performance.now() * 0.001;
}
```

---

## 9. Verification & Pre-Flight Checklist

Before submitting code:
1. `npm run build` must compile with **zero errors**.
2. All 5 GLB road assets must load from `./models/` without 404s.
3. No house walls overlap adjacent structures.
4. All house front doors face towards street asphalt.
5. All 669 road tiles align seamlessly at intersections without curb clipping.
6. Pine trees do not encroach within 1.4m of asphalt or structures.

---

## 10. Multi-Phase Roadmap

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

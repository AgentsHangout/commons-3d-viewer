import * as THREE from 'three';

/**
 * Computes a high-performance 2D distance field texture from shorelines.
 * Encodes:
 * - R: Normalized water depth (0.0 = shore, 1.0 = deep water)
 * - G: Is-water flag (1.0 = water tile, 0.0 = land tile)
 * - B: Shoreline foam proximity mask (1.0 = immediate sand/grass bank, 0.0 = open water)
 * - A: 255
 * 
 * @param {number} size World grid size (e.g. 128)
 * @param {string[]} land Array of land tile character strings
 * @returns {THREE.DataTexture}
 */
export function createWaterMapTexture(size, land) {
  const data = new Uint8Array(size * size * 4);
  const dist = new Float32Array(size * size).fill(999);
  const queue = [];

  // 1. Identify all non-water (land) tiles as boundary sources (distance = 0)
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const char = (land[z] && land[z][x]) ? land[z][x] : 'g';
      if (char !== 'w') {
        dist[z * size + x] = 0;
        queue.push(x, z);
      }
    }
  }

  // 2. BFS flood fill to compute Euclidean distance to nearest land
  let head = 0;
  const dxs = [1, -1, 0, 0, 1, -1, 1, -1];
  const dzs = [0, 0, 1, -1, 1, 1, -1, -1];
  const dws = [1.0, 1.0, 1.0, 1.0, 1.414, 1.414, 1.414, 1.414];

  while (head < queue.length) {
    const x = queue[head++];
    const z = queue[head++];
    const currentDist = dist[z * size + x];

    for (let i = 0; i < 8; i++) {
      const nx = x + dxs[i];
      const nz = z + dzs[i];
      if (nx >= 0 && nx < size && nz >= 0 && nz < size) {
        const nd = currentDist + dws[i];
        const idx = nz * size + nx;
        if (nd < dist[idx]) {
          dist[idx] = nd;
          queue.push(nx, nz);
        }
      }
    }
  }

  // 3. Populate texture data
  const maxDepthDist = 5.0; // Distance in tiles to reach deep water color
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const idx = z * size + x;
      const char = (land[z] && land[z][x]) ? land[z][x] : 'g';
      const isWater = (char === 'w') ? 1.0 : 0.0;
      const normalizedDepth = isWater ? Math.min(dist[idx] / maxDepthDist, 1.0) : 0.0;
      const foamFactor = isWater ? Math.max(0.0, 1.0 - dist[idx] / 1.5) : 0.0;

      const byteIdx = idx * 4;
      data[byteIdx]     = Math.round(normalizedDepth * 255); // R
      data[byteIdx + 1] = Math.round(isWater * 255);         // G
      data[byteIdx + 2] = Math.round(foamFactor * 255);     // B
      data[byteIdx + 3] = 255;                               // A
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Creates the stylized water system:
 * - Two-tone depth color blend (crystalline azure near beach -> deep alpine navy in open lake/ocean)
 * - Animated harmonic wave displacement with analytic normal recalculation for crisp specular glints
 * - Shoreline animated foam rim lapping against sandy banks
 * - Caustic shimmer across shallow waters
 * - PBR integration with ACESFilmic tone-mapping, sun keylight glints, and twilight moonlight
 * 
 * @param {THREE.Scene} scene The target Three.js scene
 * @param {number} size World grid dimensions
 * @param {string[]} land Land tile array
 * @returns {{ material: THREE.MeshStandardMaterial, mesh: THREE.Mesh, update: (time: number) => void }}
 */
export function createWaterSystem(scene, size, land) {
  const waterMap = createWaterMapTexture(size, land);

  // Stylized color palette matching warm sand (0xc4a86b) and timber cabins
  const shallowColor = new THREE.Color(0x1cb5c9); // Clear vibrant azure / turquoise
  const deepColor    = new THREE.Color(0x0c2a4a); // Deep alpine navy
  const foamColor    = new THREE.Color(0xeffaff); // Crisp seafoam crest

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: shallowColor,
    roughness: 0.16,
    metalness: 0.08,
    transparent: true,
    opacity: 0.92,
    flatShading: false
  });

  const uniforms = {
    uTime: { value: 0.0 },
    uWaterMap: { value: waterMap },
    uMapSize: { value: Float32Array.from([size])[0] },
    uShallowColor: { value: shallowColor },
    uDeepColor: { value: deepColor },
    uFoamColor: { value: foamColor }
  };

  waterMaterial.onBeforeCompile = (shader) => {
    // Merge custom uniforms
    Object.assign(shader.uniforms, uniforms);

    // Vertex Shader Modifications
    shader.vertexShader = `
      uniform float uTime;
      uniform sampler2D uWaterMap;
      uniform float uMapSize;

      varying vec2 vWaterUv;
      varying vec3 vWorldPosition;
      varying float vWaterDepth;
      varying float vIsWater;
    ` + shader.vertexShader;

    // Normal recalculation via analytic partial derivatives
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `
      #include <beginnormal_vertex>

      // UV mapping across the world grid
      vec2 waterUv = clamp(position.xz / uMapSize, 0.0, 1.0);
      vWaterUv = waterUv;

      vec4 waterInfo = texture2D(uWaterMap, waterUv);
      float isWater = waterInfo.g;
      float depth = waterInfo.r;
      vWaterDepth = depth;
      vIsWater = isWater;

      // Harmonic multi-frequency waves: primary slow swell + secondary cross-chop + tertiary ripple
      float w1 = sin(position.x * 0.45 + position.z * 0.35 + uTime * 1.25) * 0.024;
      float w2 = sin(position.x * 1.15 - position.z * 0.85 + uTime * 1.85) * 0.012;
      float w3 = cos(position.x * 2.30 + position.z * 1.70 + uTime * 2.60) * 0.006;

      // Analytic derivatives for true surface normals (ensures sun and moon specular glints tilt with waves)
      float dw1_dx = 0.45 * cos(position.x * 0.45 + position.z * 0.35 + uTime * 1.25) * 0.024;
      float dw1_dz = 0.35 * cos(position.x * 0.45 + position.z * 0.35 + uTime * 1.25) * 0.024;
      float dw2_dx = 1.15 * cos(position.x * 1.15 - position.z * 0.85 + uTime * 1.85) * 0.012;
      float dw2_dz = -0.85 * cos(position.x * 1.15 - position.z * 0.85 + uTime * 1.85) * 0.012;
      float dw3_dx = -2.30 * sin(position.x * 2.30 + position.z * 1.70 + uTime * 2.60) * 0.006;
      float dw3_dz = -1.70 * sin(position.x * 2.30 + position.z * 1.70 + uTime * 2.60) * 0.006;

      float slopeX = (dw1_dx + dw2_dx + dw3_dx) * isWater;
      float slopeZ = (dw1_dz + dw2_dz + dw3_dz) * isWater;

      // Perturb normal so waves catch directional keylight and hemisphere specular highlights
      objectNormal = normalize(vec3(-slopeX * 2.8, 1.0, -slopeZ * 2.8));
      `
    );

    // Vertex displacement
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      float disp = (w1 + w2 + w3) * isWater;
      transformed.y += disp;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `
      #include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );

    // Fragment Shader Modifications
    shader.fragmentShader = `
      uniform float uTime;
      uniform sampler2D uWaterMap;
      uniform float uMapSize;
      uniform vec3 uShallowColor;
      uniform vec3 uDeepColor;
      uniform vec3 uFoamColor;

      varying vec2 vWaterUv;
      varying vec3 vWorldPosition;
      varying float vWaterDepth;
      varying float vIsWater;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>

      // Discard non-water regions so water plane never clips into land/hills
      if (vIsWater < 0.05) {
        discard;
      }

      // 1. Stylized Two-Tone Depth Blend (Azure near shore -> Alpine Navy in deep waters)
      float dFactor = clamp(vWaterDepth, 0.0, 1.0);
      float depthCurve = pow(dFactor, 0.65);
      vec3 waterColor = mix(uShallowColor, uDeepColor, depthCurve);

      // 2. Animated Caustic Shimmer in shallow waters
      float c1 = sin((vWorldPosition.x + vWorldPosition.z) * 1.6 + uTime * 2.2);
      float c2 = cos((vWorldPosition.x - vWorldPosition.z) * 1.9 - uTime * 1.9);
      float caustic = pow(max(0.0, c1 * c2), 3.0) * (1.0 - smoothstep(0.08, 0.60, vWaterDepth)) * 0.28;
      waterColor += vec3(caustic);

      // 3. Shoreline Animated Foam Rim lapping against beach/sand banks
      float foamNoise = sin(vWorldPosition.x * 4.5 + uTime * 3.0) * cos(vWorldPosition.z * 4.5 - uTime * 2.5) * 0.04;
      float shoreEdge = vWaterDepth + foamNoise;
      float foamBand = smoothstep(0.18, 0.03, shoreEdge);
      float foamWave = sin(shoreEdge * 38.0 - uTime * 3.8) * 0.5 + 0.5;
      float foam = foamBand * step(0.42, foamWave) * (1.0 - smoothstep(0.0, 0.20, vWaterDepth));

      waterColor = mix(waterColor, uFoamColor, clamp(foam * 0.88, 0.0, 1.0));

      diffuseColor.rgb = waterColor;
      // Semi-transparency allows the submerged riverbed profile beneath to peek through near shores
      diffuseColor.a = mix(0.85, 0.96, depthCurve);
      `
    );

    waterMaterial.userData.shader = shader;
  };

  // Higher subdivision (size * 2) gives silky-smooth wave curves across the 128x128 map
  const segments = size * 2;
  const waterGeo = new THREE.PlaneGeometry(size, size, segments, segments);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate(size / 2, -0.08, size / 2);

  const waterMesh = new THREE.Mesh(waterGeo, waterMaterial);
  waterMesh.receiveShadow = true;
  scene.add(waterMesh);

  // Time updater function called each frame
  const update = (timeSeconds) => {
    uniforms.uTime.value = timeSeconds;
    if (waterMaterial.userData?.shader?.uniforms?.uTime) {
      waterMaterial.userData.shader.uniforms.uTime.value = timeSeconds;
    }
  };

  return {
    material: waterMaterial,
    mesh: waterMesh,
    uniforms,
    update
  };
}

import { test, expect } from '@playwright/test';
import { DRAW_CALL_LIMIT, SCENE_READY_TIMEOUT_MS } from './perf.config.js';

function isIgnorableAsset(url) {
  return url.endsWith('/favicon.ico');
}

test.describe('Commons draw-call budget', () => {
  test('default scene stays at or below the draw-call limit', async ({ page }) => {
    const failedAssets = [];

    page.on('pageerror', (err) => {
      console.error(`[perf] pageerror: ${err.message}`);
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const loc = msg.location();
      if (isIgnorableAsset(loc.url || '')) return;
      console.error(`[perf] console: ${msg.text()} (${loc.url}:${loc.lineNumber})`);
    });
    page.on('response', (res) => {
      if (res.status() < 400) return;
      const url = res.url();
      if (isIgnorableAsset(url)) return;
      failedAssets.push(`${res.status()} ${url}`);
      console.error(`[perf] HTTP ${res.status()} ${url}`);
    });

    await page.goto('/?perf');

    await page.waitForFunction(() => window.__sceneReady === true, null, {
      timeout: SCENE_READY_TIMEOUT_MS
    });

    const result = await page.evaluate(async () => {
      const waitFrames = (n) =>
        new Promise((resolve) => {
          const step = () => {
            if (--n <= 0) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });

      // Let the animation loop render the finished scene a few times.
      await waitFrames(3);

      if (!window.__perf || typeof window.__perf.getDrawCalls !== 'function') {
        return { ok: false, reason: 'window.__perf.getDrawCalls is missing (open with ?perf)' };
      }

      const canvas = document.querySelector('#canvas-container canvas');
      let gpu = { ok: false, reason: 'no canvas' };
      if (canvas) {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
          gpu = { ok: false, reason: 'no WebGL context' };
        } else {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          gpu = {
            ok: true,
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext
              ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER)
          };
        }
      }

      return {
        ok: true,
        calls: window.__perf.getDrawCalls(),
        info: typeof window.__perf.getInfo === 'function' ? window.__perf.getInfo() : null,
        gpu
      };
    });

    expect(result.ok, result.reason ?? 'perf hooks unavailable').toBe(true);
    expect(result.gpu?.ok, `WebGL unavailable: ${result.gpu?.reason}`).toBe(true);

    expect(failedAssets, `asset load failures:\n${failedAssets.join('\n')}`).toEqual([]);

    const calls = result.calls;
    console.log(`[perf] draw calls: ${calls} (limit ${DRAW_CALL_LIMIT})`);
    if (result.info) {
      console.log(`[perf] renderer.info.render: ${JSON.stringify(result.info)}`);
    }
    if (result.gpu) {
      console.log(`[perf] GPU: ${result.gpu.vendor} / ${result.gpu.renderer}`);
    }

    expect(calls, 'expected at least one draw call after the scene rendered').toBeGreaterThan(0);
    expect(
      calls,
      `draw calls ${calls} exceed the budget of ${DRAW_CALL_LIMIT} (edit tests/perf.config.js or set DRAW_CALL_LIMIT)`
    ).toBeLessThanOrEqual(DRAW_CALL_LIMIT);
  });

  test('tree scatter generation is deterministic across frames and builds', async ({ page }) => {
    await page.goto('/?perf');
    await page.waitForFunction(() => window.__sceneReady === true, null, {
      timeout: SCENE_READY_TIMEOUT_MS
    });
    const res1 = await page.evaluate(() => ({
      count: typeof window.__perf?.getTreeCount === 'function' ? window.__perf.getTreeCount() : null,
      first: typeof window.__perf?.getFirstTree === 'function' ? window.__perf.getFirstTree() : null
    }));

    expect(res1.count, 'expected tree count to be non-zero').toBeGreaterThan(0);
    expect(res1.count, 'expected tree count within 5000 cap').toBeLessThanOrEqual(5000);
    expect(res1.first, 'expected first tree transform').not.toBeNull();

    // Reload the scene and verify identical deterministic tree generation
    await page.reload();
    await page.waitForFunction(() => window.__sceneReady === true, null, {
      timeout: SCENE_READY_TIMEOUT_MS
    });
    const res2 = await page.evaluate(() => ({
      count: typeof window.__perf?.getTreeCount === 'function' ? window.__perf.getTreeCount() : null,
      first: typeof window.__perf?.getFirstTree === 'function' ? window.__perf.getFirstTree() : null
    }));

    expect(res2.count, 'expected tree count to match across reloads').toBe(res1.count);
    expect(res2.first?.x, 'expected first tree X to match').toBeCloseTo(res1.first.x, 3);
    expect(res2.first?.z, 'expected first tree Z to match').toBeCloseTo(res1.first.z, 3);
    expect(res2.first?.scale, 'expected first tree scale to match').toBeCloseTo(res1.first.scale, 3);
  });

  test('road grounding and terrain corridor grading eliminate occlusion (Issue #18)', async ({ page }) => {
    await page.goto('/?perf');
    await page.waitForFunction(() => window.__sceneReady === true, null, {
      timeout: SCENE_READY_TIMEOUT_MS
    });

    const elevationReport = await page.evaluate(() => {
      if (!window.__perf) return null;
      const getRoadElev = window.__perf.getRoadElevation;
      const tMesh = window.__perf.getTerrainMesh();
      const pos = tMesh?.geometry?.attributes?.position;
      const size = 128;

      const getTerrainY = (vx, vz) => {
        const idx = vz * (size + 1) + vx;
        return pos ? pos.getY(idx) : null;
      };

      // 1. Roads bordering forest at (45, 23)
      const road45_23 = getRoadElev(45, 23);
      // Boundary vertex (46, 23) shared between road (45, 23) and forest (46, 23)
      const vertex46_23_y = getTerrainY(46, 23);

      // 2. Southeast forest arterial roads at (115..123, 109)
      const forestRoads = [];
      for (let x = 115; x <= 123; x++) {
        forestRoads.push(getRoadElev(x, 109));
      }

      // 3. Road near southern hills at (16, 92)
      const road16_92 = getRoadElev(16, 92);

      // 4. Sorrel Woods studio road cul-de-sac at (23, 57)
      const road23_57 = getRoadElev(23, 57);

      return {
        road45_23,
        vertex46_23_y,
        forestRoads,
        road16_92,
        road23_57
      };
    });

    expect(elevationReport, 'perf elevation inspection unavailable').not.toBeNull();

    // 1. Border road at (45, 23) is on sand datum Y=0.00
    expect(elevationReport.road45_23).toBeCloseTo(0.00, 3);
    // Boundary vertex between sand road (45, 23) and forest (46, 23) must be graded to 0.00m (min road elevation)
    // to prevent forest terrain quad from slicing through road asphalt!
    expect(elevationReport.vertex46_23_y).toBeCloseTo(0.00, 3);

    // 2. Southeast forest arterial roads sit flush on forest plinth at Y=0.10m
    expect(elevationReport.forestRoads).toHaveLength(9);
    for (const elev of elevationReport.forestRoads) {
      expect(elev).toBeCloseTo(0.10, 3);
    }

    // 3. Road at (16, 92) near hills sits at 0.00m
    expect(elevationReport.road16_92).toBeCloseTo(0.00, 3);

    // 4. Road at (23, 57) on forest plinth sits at 0.10m
    expect(elevationReport.road23_57).toBeCloseTo(0.10, 3);
  });
});


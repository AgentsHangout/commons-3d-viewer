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

  test('connected road network elevation resolution guarantees step-free continuity (Section 10, Issue #18)', async ({ page }) => {
    await page.goto('/?perf');
    await page.waitForFunction(() => window.__sceneReady === true, null, {
      timeout: SCENE_READY_TIMEOUT_MS
    });

    const report = await page.evaluate(() => {
      if (!window.__perf) return null;
      const getRoadElev = window.__perf.getRoadElevation;
      const roadItems = window.__perf.getRoadItems ? window.__perf.getRoadItems() : [];
      const tMesh = window.__perf.getTerrainMesh();
      const pos = tMesh?.geometry?.attributes?.position;
      const size = 128;

      const getTerrainY = (vx, vz) => {
        const idx = vz * (size + 1) + vx;
        return pos ? pos.getY(idx) : null;
      };

      // 1. Step-free invariant across all adjacent connected roads
      let maxStep = 0;
      let stepViolations = 0;
      for (const r of roadItems) {
        const y = getRoadElev(r.x, r.y);
        const neighbors = [
          { x: r.x + 1, y: r.y },
          { x: r.x - 1, y: r.y },
          { x: r.x,     y: r.y + 1 },
          { x: r.x,     y: r.y - 1 }
        ];
        for (const n of neighbors) {
          const ny = getRoadElev(n.x, n.y);
          if (typeof ny === 'number' && !Number.isNaN(ny)) {
            const step = Math.abs(y - ny);
            if (step > maxStep) maxStep = step;
            if (step > 0.001) stepViolations++;
          }
        }
      }

      // 2. Specific key coordinates from Section 10
      // Poppy Cross Market
      const poppy101_97 = getRoadElev(101, 97);
      const poppy100_97 = getRoadElev(100, 97);
      const poppy101_98 = getRoadElev(101, 98);

      // Sorrel Woods Studio
      const sorrel23_57 = getRoadElev(23, 57);
      const sorrel24_57 = getRoadElev(24, 57);

      // Southeast forest corridor
      const se114_109 = getRoadElev(114, 109);
      const se115_109 = getRoadElev(115, 109);

      // Border road at (45, 23) and graded terrain vertex at (46, 23)
      const road45_23 = getRoadElev(45, 23);
      const vertex46_23_y = getTerrainY(46, 23);

      return {
        totalRoads: roadItems.length,
        maxStep,
        stepViolations,
        poppy101_97,
        poppy100_97,
        poppy101_98,
        sorrel23_57,
        sorrel24_57,
        se114_109,
        se115_109,
        road45_23,
        vertex46_23_y
      };
    });

    expect(report, 'perf elevation inspection unavailable').not.toBeNull();
    expect(report.totalRoads).toBe(669);

    // 1. Step-free invariant: no adjacent connected road has vertical discrepancy > 0.001m
    expect(report.stepViolations).toBe(0);
    expect(report.maxStep).toBeLessThan(0.001);

    // 2. Poppy Cross market at (101, 97) is 0.00m and matches (100, 97) and (101, 98) without vertical step
    expect(report.poppy101_97).toBeCloseTo(0.00, 3);
    expect(report.poppy100_97).toBeCloseTo(0.00, 3);
    expect(report.poppy101_98).toBeCloseTo(0.00, 3);
    expect(Math.abs(report.poppy101_97 - report.poppy100_97)).toBeLessThan(0.001);
    expect(Math.abs(report.poppy101_97 - report.poppy101_98)).toBeLessThan(0.001);

    // 3. Sorrel Woods at (23, 57) is 0.00m and matches (24, 57)
    expect(report.sorrel23_57).toBeCloseTo(0.00, 3);
    expect(report.sorrel24_57).toBeCloseTo(0.00, 3);
    expect(Math.abs(report.sorrel23_57 - report.sorrel24_57)).toBeLessThan(0.001);

    // 4. Southeast forest corridor at (115, 109) is 0.00m and matches (114, 109)
    expect(report.se115_109).toBeCloseTo(0.00, 3);
    expect(report.se114_109).toBeCloseTo(0.00, 3);
    expect(Math.abs(report.se115_109 - report.se114_109)).toBeLessThan(0.001);

    // 5. Border road at (45, 23) and boundary vertex at (46, 23) remain 0.00m with zero occlusion
    expect(report.road45_23).toBeCloseTo(0.00, 3);
    expect(report.vertex46_23_y).toBeCloseTo(0.00, 3);
  });
});

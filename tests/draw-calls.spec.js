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
    const res = await page.evaluate(() => ({
      count: typeof window.__perf.getTreeCount === 'function' ? window.__perf.getTreeCount() : null,
      first: typeof window.__perf.getFirstTree === 'function' ? window.__perf.getFirstTree() : null
    }));
    expect(res.count, 'expected tree count to be deterministic').toBe(785);
    expect(res.first?.x).toBeCloseTo(74.63, 1);
    expect(res.first?.z).toBeCloseTo(17.54, 1);
  });
});

import { test } from '@playwright/test';
import path from 'path';

const ARTIFACTS_DIR = 'C:/Users/beesl/.gemini/antigravity/brain/56be11b5-3d29-434c-bc68-bf288d10b08b';

test.describe('Diagnostic Visual Capture Suite', () => {
  test('capture multi-angle visual inspection screenshots', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/?perf');
    await page.waitForFunction(() => window.__sceneReady === true, null, { timeout: 25000 });

    const captureView = async (filename, camPos, targetPos) => {
      await page.evaluate(({ cam, target }) => {
        if (window.__perf && window.__perf.setCameraView) {
          window.__perf.setCameraView(cam, target);
        }
      }, { cam: camPos, target: targetPos });

      await page.waitForTimeout(600);
      const outPath = path.join(ARTIFACTS_DIR, filename);
      await page.screenshot({ path: outPath });
      console.log(`[Diagnostic] Captured: ${filename}`);
    };

    // 1. Studio at (52, 33) - FRONT view looking South (into transparent glass windows)
    await captureView('diag_studio_front_glass.png', { x: 52, y: 0.9, z: 31.0 }, { x: 52, y: 0.7, z: 33 });

    // 2. Studio at (52, 33) - 3/4 perspective showing east glass facade
    await captureView('diag_studio_perspective.png', { x: 54.5, y: 1.5, z: 31.0 }, { x: 52, y: 0.7, z: 33 });

    // 3. Cabin (55, 57) - Low angle looking up at eaves
    await captureView('diag_cabin_eaves_low.png', { x: 55, y: 1.0, z: 61 }, { x: 55, y: 1.8, z: 57 });

    // 4. Cabin (55, 57) - 3/4 Perspective view
    await captureView('diag_cabin_perspective.png', { x: 58, y: 3.5, z: 62 }, { x: 55, y: 0.8, z: 57 });

    // 5. Workshop (48, 33) - Front view
    await captureView('diag_workshop_facade.png', { x: 48, y: 1.2, z: 31.0 }, { x: 48, y: 0.8, z: 33 });

    // 6. Trees - Side view of pine boughs
    await captureView('diag_pine_tree_foliage.png', { x: 56, y: 3.0, z: 52 }, { x: 52, y: 2.0, z: 50 });

    // 7. Road Corner - Poppy Cross (101, 97)
    await captureView('diag_road_corner_poppy.png', { x: 101, y: 8.0, z: 103 }, { x: 101, y: 0.0, z: 97 });
  });
});

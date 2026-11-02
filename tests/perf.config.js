/**
 * Draw-call budget for the default Commons camera (/?perf).
 *
 * Change DRAW_CALL_LIMIT here to raise or lower the CI gate, or override
 * at runtime: DRAW_CALL_LIMIT=24 npm run test:perf
 */
export const DRAW_CALL_LIMIT = Number.parseInt(process.env.DRAW_CALL_LIMIT ?? '20', 10);

if (!Number.isFinite(DRAW_CALL_LIMIT) || DRAW_CALL_LIMIT < 1) {
  throw new Error(`DRAW_CALL_LIMIT must be a positive integer, got ${process.env.DRAW_CALL_LIMIT}`);
}

/** How long to wait for window.__sceneReady after opening /?perf. */
export const SCENE_READY_TIMEOUT_MS = Number.parseInt(
  process.env.SCENE_READY_TIMEOUT_MS ?? '60000',
  10
);

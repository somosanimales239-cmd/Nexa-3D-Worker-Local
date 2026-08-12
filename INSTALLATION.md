# Nexa 3D Worker Local 1.6.0 — Orientation Multi-View Texture Bake

Install third, after Worker 1.5.0. This package is cumulative for the multi-view Worker stage.

## Replace / add
- `src/backend/nexa-worker.js`
- `src/backend/multi-view-reconstruction.js`
- `src/backend/multi-view-texture.js` (new)
- `package.json`

## What it does automatically after geometry reconstruction
- Front is projected toward the front-facing surfaces.
- Back is projected toward the rear-facing surfaces.
- Left / Right, when supplied, are projected toward the matching side surfaces.
- Transparent reference backgrounds use a neutral fallback instead of painting empty space black.
- Blender generates a new quality UV atlas.
- The orientation-aware projection material is baked to one 4096 x 4096 texture atlas.
- The temporary projection graph is replaced with a normal baked PBR material.
- The final result is exported as one GLB and uploaded back to Nexa automatically.

There is no separate Quick Texture action required for this multi-view generation workflow.

## Important accuracy note
This update uses the current working 3D engine + Blender. It materially uses the Back/Side views instead of ignoring them, but it does not add a separate large generative texture model. Areas not visible in any supplied reference are blended from the nearest available views rather than semantically invented by a Meshy-class texturing model.

# Nexa 3D Worker Local Update 1.7.0 — Single Mesh Professional Refine + Polish

## Install
Copy and replace these files inside the local worker project:

- `src/backend/nexa-worker.js`
- `src/backend/multi-view-texture.js`
- `package.json`
- `nexa.project.json`

## What changes
- Keeps **one base geometry from the Front view**.
- Uses Back / Left / Right only for **orientation-correct multi-view texture refinement**.
- Adds a **professional polish pass** during Blender baking.
- Fixes the logic so Front / Back are not treated as duplicate full-body reconstructions.
- Adds explicit `front_positive_y` orientation mode and better projection weighting.

## After install
1. Restart the local Worker.
2. Start a new job from the updated web create screen.
3. For best results, use Front + Back at minimum.

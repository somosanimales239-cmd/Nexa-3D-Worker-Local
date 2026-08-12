# Nexa 3D Worker Local 1.5.0 — Multi-View Geometry Reconstruction

Install after Web 2.1.0.

## Replace / add
- `src/backend/nexa-worker.js`
- `src/backend/multi-view-reconstruction.js` (new)
- `package.json`

## What it does
For `quality_multiview` jobs, the Worker no longer treats Back / Left / Right as passive reference files.

It now:
1. downloads Front, Back and available Side references automatically;
2. runs the existing 3D engine independently for each supplied view at High quality;
3. rotates the view reconstructions into their expected orientation;
4. uses the already configured local Blender executable to normalize and fuse the view geometry;
5. performs a quality-first voxel remesh and conservative decimation;
6. returns one coherent GLB shell.

This specifically makes the rear silhouette participate in geometry instead of being inferred only from Front.

## Requirements
- Existing Stable Fast 3D / selected provider remains installed exactly as it is now.
- Blender path remains the one already configured in Engine Setup.
- No new AI model download is introduced.

The final texture stage is added by Worker 1.6.0. Install 1.6.0 immediately after this update.

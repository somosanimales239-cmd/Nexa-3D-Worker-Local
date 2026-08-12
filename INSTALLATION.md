# Nexa 3D Worker Local 1.7.1 — 8GB VRAM Safe Generation Fix

Replace these files in the Worker project:

- `src/backend/nexa-worker.js`
- `package.json`
- `nexa.project.json`

Then rebuild/install the Worker normally.

What changed:
- SF3D base geometry now uses a temporary 1024px bake instead of 2048px.
- Final professional multi-view polish still uses up to 4096px in Blender.
- Batch size is forced to 1.
- CUDA is explicit when GPU mode is enabled.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` is applied to the SF3D process.

No web update is required.

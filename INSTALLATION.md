# Nexa 3D Worker Local 1.6.2 — Multi-View Texture 88% Bake Fix

This is an incremental Worker source update. It does not change the Nexa 3D Studio web page, Stable Fast 3D installation, Hugging Face cache, Blender installation, or user settings.

## Apply
1. In Nexa App Builder Pro open Manual Delivery for the existing **Nexa 3D Worker Local** project.
2. Create a new Manual Delivery and upload this ZIP.
3. Apply staged files once.
4. Confirm Local build validation is Ready.
5. Push to GitHub & Build. If Nexa reports an externally uncertain dispatch after the push, use the already-installed GitHub dispatch reconciliation action rather than creating another source revision.
6. Download/install the resulting **1.6.2** Windows Worker build.
7. Re-queue the same Front + Back test.

## What is fixed
- Replaces the fragile diffuse/pass-filter texture bake with a color-only **Emission bake** in Cycles CPU mode.
- Keeps 4096x4096 as the first texture bake resolution.
- Falls back to 2048 only if Blender reports an actual memory-allocation failure.
- Captures Blender Python tracebacks into the Worker error instead of returning only “GLB was not created”.
- Makes normal progress telemetry retry up to three times and no longer aborts a successful local SF3D operation because a non-critical progress POST had one transient `fetch failed` error.

No Blender reinstall is required.

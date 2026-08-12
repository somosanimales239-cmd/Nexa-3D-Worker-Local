# Nexa 3D Worker Local 1.6.3 — Single-Base Geometry Quality Fix

This update removes the destructive geometry-fusion path introduced for multi-view character generation.

## What changes

- Front remains the single authoritative geometry reconstruction.
- Back / Left / Right are no longer reconstructed into separate complete 3D bodies.
- No 180-degree Back body rotation, object join, or voxel remesh is used in the generation flow.
- Back / Left / Right are used only as texture evidence on the single coherent base mesh.
- 4096px multi-view texture bake remains enabled, with the existing memory-safe 2048 fallback only for real allocation failures.

## Install

Upload this ZIP through Nexa App Builder Pro -> Manual Delivery for Nexa 3D Worker Local, Apply, validate, Push to GitHub & Build, then install the resulting Worker 1.6.3.

Do not reinstall Stable Fast 3D, Blender, Python, or the Hugging Face cache.

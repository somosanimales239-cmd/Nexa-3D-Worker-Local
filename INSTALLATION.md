# Nexa 3D Worker Local Update 1.3.0 — Integrated Quick Texture

Install this update SECOND.

## What changes
Quick Texture is now part of the NORMAL Nexa 3D Worker loop. No separate console or bridge script is needed.

When the Worker is Running it automatically checks for:
1. Quick Texture jobs
2. Image → 3D generation jobs
3. Apply Package dispatch jobs

## Quick Texture engine
- Detects Blender automatically when possible.
- Adds Blender status to **Engine Setup**.
- Lets you choose `blender.exe` if auto-detection does not find it.
- Adds **Enable automatic Quick Texture jobs**.
- Preserves existing GLB materials/textures when they already exist.
- Tunes roughness / metallic / saturation.
- If the model lacks a usable texture, it uses the original Image → 3D source image or the first saved reference as a fast fallback texture.
- Exports a new GLB and uploads it to Nexa automatically.
- Stop Worker can terminate the active Blender process.

## One-time requirement
Blender must be installed on the Windows PC. This update does not silently install Blender.

## Installation
Replace only the files included in this ZIP inside the current Nexa 3D Worker Local project, then rebuild/install the Worker the same way you already build it.

Do NOT run `scripts/start-quick-texture-bridge.js`; it now only tells you that Quick Texture is integrated into the normal Worker.

Nexa 3D Worker Local Update 1.2.0 — Quick Texture One Click

PURPOSE
This update adds a very fast local quick-texture processor for models that already exist.
It is inspired by a Meshy-like one-click workflow:
- object already created
- click one button
- worker quickly applies color and texture
- especially useful when the model was created from an image

WHAT IT DOES
- claims quick-texture jobs from the website automatically
- downloads a quick-texture bundle automatically
- uses Blender headless to:
  - import the GLB
  - smart-unwrap UVs
  - apply the original image as a texture
  - create a principled material quickly
  - export a quick textured GLB
- uploads the result automatically back to Nexa

FILES INCLUDED
- src/backend/quick-texture-processor.js
- src/backend/quick-texture-bridge.js
- scripts/start-quick-texture-bridge.js

REQUIREMENTS
- Blender installed locally
- working worker token
- the web update 1.7.0 installed
- Windows is recommended for this version because ZIP extraction uses Expand-Archive

BASIC USE
1. Install the web update 1.7.0.
2. Add the one-click Quick Texture button in the website preview area.
3. Install these worker files.
4. Set environment variables:
   - NEXA_QUICK_TEXTURE_BASE_URL
   - NEXA_QUICK_TEXTURE_WORKER_TOKEN
   - NEXA_QUICK_TEXTURE_WORKER_ID
   - NEXA_BLENDER_PATH (optional if Blender is in a default path)
5. Start the bridge:
   node scripts/start-quick-texture-bridge.js

IMPORTANT
This is a fast automatic color + texture pass.
It is not a full PBR authoring suite.
The goal is speed, convenience, and a one-click workflow similar to what you described.

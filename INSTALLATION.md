# Nexa 3D Worker Local v1.6.1 — Final Pre-GitHub Source Validation Fix

This is a source-only correction before the GitHub build.

## Replace these files in the existing Nexa 3D Worker Local project
- `src/app.js`
- `src/backend/apply-package-store.js`
- `src/backend/nexa-worker.js`
- `src/backend/quick-texture-bridge.js`
- `package.json`
- `nexa.project.json`

## What was fixed
- Rewrote the Apply Packages renderer so Nexa's local delimiter scanner no longer mistakes nested JavaScript template literals for broken braces.
- Restored clean validated copies of the three backend files reported by Local build validation.
- Increased application version to `1.6.1` consistently in `package.json` and `nexa.project.json`.
- Strengthened `npm run validate` so it explicitly runs `node --check` on Apply Package, Quick Texture and Multi-View source files before GitHub packaging.

## Install
1. Open the existing Nexa 3D Worker Local project in Manual Delivery.
2. Upload this ZIP.
3. Stage and apply the files.
4. Return to Local build validation.
5. Do not run Normalize Installer/Portable/ZIP unless a delivery configuration error is separately reported.
6. When Local build validation is Ready, use Push to GitHub & Build.

No Blender, Stable Fast 3D, Hugging Face cache, worker token or local settings are changed by this update.

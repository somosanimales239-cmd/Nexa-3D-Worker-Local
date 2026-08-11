# Nexa 3D Worker Local v1.1.0 — Apply Package Workflow

## Purpose
This is the worker-side companion update for the web Enhance 3D Phase 4.

It adds a new page called **Apply Packages** so you can:
1. download an Apply Package ZIP from Nexa 3D Studio Web,
2. import it into Nexa 3D Worker Local,
3. process it locally,
4. attach the finished GLB / GLTF / ZIP result.

## Replace / add these files in your worker project
- `main.js`
- `preload.js`
- `package.json`
- `src/app.js`
- `src/index.html`
- `src/styles.css`
- `src/backend/apply-package-store.js` (new)

## New area
Inside the worker app you will see a new navigation item:
- **Apply Packages**

## Basic flow
- In the web page, create an Apply Package.
- Download the ZIP.
- In Nexa 3D Worker Local, open **Apply Packages**.
- Choose the ZIP and click **Import Apply Package**.
- When your local enhancement work is done, click **Attach Result File**.
- The package stays organized locally with its ZIP, metadata and result.

## Safety
- Does not remove the original worker image-to-3D functionality.
- Does not touch your existing Stable Fast 3D installation.
- Keeps local apply package records in the worker app data folder.

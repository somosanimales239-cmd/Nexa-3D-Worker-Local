# Nexa 3D Worker Local

Windows desktop worker for **Nexa 3D Studio Image → 3D**. It does not use OpenAI.

## What this project does

1. Connects to the existing Nexa 3D Studio worker API.
2. Polls for queued Image → 3D jobs using outbound HTTPS only.
3. Downloads the protected source image after claiming a job.
4. Runs a local 3D engine on this computer.
5. Validates the generated GLB 2.0 file and SHA-256.
6. Uploads the GLB back to Nexa.
7. Nexa imports the result into My 3D Models for Viewer / Download / Send to Web Project / GitHub delivery.

## Engines

### Stable Fast 3D — default

The application can clone the official Stable Fast 3D source, create a dedicated Python virtual environment and install its Python requirements. Stable Fast 3D's upstream Windows support is experimental. Its model is gated on Hugging Face, so your account must have access and a valid token must be supplied before first generation.

Official project: https://github.com/Stability-AI/stable-fast-3d

### Hunyuan3D local API — optional

If you already run Hunyuan3D's local API server, select `Hunyuan3D — Local API` and enter its localhost URL. The worker sends the source image to the local `/generate` endpoint and receives a GLB.

Official project: https://github.com/Tencent-Hunyuan/Hunyuan3D-2

Provider/model licenses are separate from Nexa. Review the current upstream license before commercial deployment.

## Create this software in Nexa App Builder Pro

Create a new software project named:

`Nexa 3D Worker Local`

Then use Manual Delivery and upload this ZIP with its folder structure intact.

Expected project root:

```text
package.json
nexa.project.json
main.js
preload.js
src/
scripts/
README.md
```

Build target: Windows x64.

The package is prepared for the existing Nexa Windows build contract and produces NSIS installer, Portable EXE and ZIP through `npm run build:win`.

## First launch after installing the Windows application

1. Open **Nexa App Builder Pro → Nexa 3D Studio → Settings**.
2. Copy **Nexa worker API base**.
3. Copy **Worker token**.
4. Open **Nexa 3D Worker Local → Nexa Connection**.
5. Paste both values and press **Save connection**.
6. Press **Test connection**.
7. Open **Engine Setup**.
8. Install / configure one local engine.
9. Use **Local Image → 3D Test** to verify that a real GLB can be generated on this PC.
10. Return to Dashboard and press **Start Worker**.

## Security design

- The worker makes outbound requests to Nexa. It does not require an inbound internet port.
- The Nexa worker token is encrypted with Electron/Windows safe storage when available.
- The Hugging Face token is also stored through safe storage when available.
- The worker receives no GitHub token.
- It never reads Nexa's SQLite database directly.
- It never calls OpenAI.
- It never triggers Nexa software builds or GitHub Actions.

## Local data

Runtime configuration, engines, logs and temporary work files are stored under Electron's Windows user-data directory, not inside the installed Program Files directory. This keeps the installer immutable and allows engine data to survive normal application updates.

## Validation

Run:

```text
npm run validate
```

Then build:

```text
npm run build:win
```

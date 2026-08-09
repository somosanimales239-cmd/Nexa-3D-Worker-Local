# Installation — Nexa 3D Worker Local v1.0.1

## Create the project in Nexa App Builder Pro

1. Create a new project named **Nexa 3D Worker Local**.
2. Open **Manual Delivery**.
3. Create a delivery for that project.
4. Upload `Nexa_3D_Worker_Local_v1.0.1_Project.zip`.
5. Stage the ZIP.
6. Apply staged files.
7. Connect the project to GitHub using Nexa's existing GitHub screen.
8. Push to GitHub & Build using Nexa's normal build flow.
9. Download the Windows installer or Portable artifact produced by Nexa.

The ZIP is intentionally rooted at `package.json`; do not place its contents inside another source folder.

## First run of the installed application

1. In the website open **Nexa 3D Studio → Settings**.
2. Copy **Nexa worker API base** and **Worker token**.
3. In the installed application open **Nexa Connection** and paste both values.
4. Save and press **Test connection**.
5. Open **Engine Setup**.
6. Choose Stable Fast 3D or Hunyuan3D local API.
7. Verify the engine using **Local Image → 3D Test**.
8. Return to Dashboard and press **Start Worker**.

## Stable Fast 3D note

The app can clone the upstream repository, create its dedicated virtual environment and install Python requirements. The upstream model is gated on Hugging Face, so approved model access and a token are required. Windows support is experimental upstream; a compatible Python/PyTorch/CUDA toolchain may be required for GPU use.

## Package lock

`package-lock.json` is intentionally not shipped in this source package. Nexa's current Windows build workflow already generates a portable lock when one is absent before running the locked dependency installation.

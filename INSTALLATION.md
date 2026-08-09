# Nexa 3D Worker Local v1.0.2 — UI Smoke Fix

Apply this ZIP to the EXISTING Nexa 3D Worker Local project through Manual Delivery.

1. Manual Delivery → Create Delivery.
2. Select the existing **Nexa 3D Worker Local** project.
3. Upload this v1.0.2 fix ZIP.
4. Stage ZIP.
5. Apply staged files.
6. Push to GitHub & Build.

Do not recreate the repository and do not change the GitHub token. The previous GitHub run already proved checkout, dependency installation, validation, and tests are working. This update only fixes the UI smoke harness that blocked the build before installer creation.

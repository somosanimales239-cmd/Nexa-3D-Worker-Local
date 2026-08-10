# Nexa 3D Worker Local v1.0.4 — Hugging Face Cache Location Fix

Apply this ZIP to the existing **Nexa 3D Worker Local** project using Manual Delivery, then Push to GitHub & Build as usual.

After installing v1.0.4:

1. Open **Engine Setup**.
2. Confirm **Repository folder** is still your existing Stable Fast 3D installation.
3. Confirm **Engine Python** is still the existing `.venv\Scripts\python.exe`.
4. Set **Hugging Face cache folder** to a drive with enough free space, for example `D:\N3D\HuggingFace`.
5. Keep the existing Hugging Face token.
6. Keep **Force CPU** enabled while the installed PyTorch build is CPU-only.
7. Save settings, then start the Worker and run one generation.
8. Activity & Logs will print the exact Hugging Face cache path used by Stable Fast 3D before the model starts.
9. While that cache folder is configured, Nexa also places temporary per-job Stable Fast 3D work under `<cache folder>\nexa-worker-temp` instead of filling the Windows application-data drive.

This update does **not** reinstall Stable Fast 3D and does not modify the Nexa website, GitHub Actions, project data, login, or other Nexa modules.

NEXA 3D WORKER LOCAL — UPDATE 1.8.0

WHAT THIS UPDATE CHANGES
- Adds provider: Hunyuan3D Multi-View Local — Recommended.
- Uses the existing Hunyuan installation directly (default D:\N3D\hunyuan2mv).
- Front + Back + Left + Right feed Hunyuan3D-2mv native geometry.
- Releases the shape model before loading Hunyuan Paint.
- Uses Hunyuan Paint Turbo with CPU offload.
- Face Priority Polish adds an automatic high-resolution head/face crop from Front as extra Paint evidence.
- Texture Polish applies a conservative final sharpen/color-retention pass to the texture atlas when safely accessible.
- Automatically falls back High -> Balanced -> VRAM Safe on CUDA OOM during shape generation.
- Bypasses the old SF3D + Blender multi-view texture route when this provider is selected.
- Keeps white_mesh.glb, textured.glb and final.glb inside the job folder while processing.

HOW TO APPLY
1. Extract this ZIP into the ROOT of Nexa-3D-Worker-Local (same folder as package.json).
2. Run APPLY_WORKER_UPDATE.bat.
3. Run: npm run validate
4. Build normally: npm run build:win

ONE-TIME WORKER SETTINGS
Provider: Hunyuan3D Multi-View Local — Recommended
Hunyuan folder: D:\N3D\hunyuan2mv
Hunyuan Python: D:\N3D\hunyuan2mv\.venv\Scripts\python.exe
Hunyuan cache: D:\N3D\HunyuanCache
Heavy temp: D:\N3D\temp

IMPORTANT
This update does NOT reinstall PyTorch, CUDA, Hunyuan, custom_rasterizer, mesh_processor or models.
It reuses the installation that already produced the successful textured GLB.

Nexa 3D Worker Local Update 1.1.1 — Automatic Web ↔ Worker Bridge

INSTALLATION
1. Back up your current Nexa 3D Worker Local folder.
2. Copy the files from this ZIP over your current worker project.
3. Replace existing files when prompted.
4. Start the worker again.

WHAT THIS UPDATE DOES
- The worker now polls the web for queued Apply Package dispatch jobs.
- When one is found, the worker automatically:
  - claims it
  - downloads the Apply Package ZIP
  - imports it into Apply Packages locally
  - creates a watched result folder
  - waits for the finished GLB / GLTF / ZIP
  - uploads the result back to Nexa automatically

HOW TO USE IT
1. In Nexa 3D Studio Web, create an Apply Package and send it to the Worker Queue.
2. In Nexa 3D Worker Local, keep the worker running.
3. The package will appear automatically under Apply Packages.
4. Open the watched result folder and place the finished GLB / GLTF / ZIP there.
5. The worker uploads it back to the website automatically.

IMPORTANT
- This update automates the transfer and return flow.
- It does NOT automatically perform artistic 3D enhancement by itself.
- You still need your local workflow or software to produce the finished model file.

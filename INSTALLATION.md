Nexa 3D Worker Local Update 1.4.0
Guided Color Paint Processor

INSTALL
1. Keep your existing Blender installation and Blender Path. Do not reinstall Blender.
2. Replace the included files in the existing Nexa 3D Worker Local source project.
3. Rebuild / reinstall the Worker using the same process used for the current Worker version.
4. Keep the existing Nexa Connection token and settings.

WHAT CHANGED
- Adds guided Quick Texture paint modes received from Web 2.0.0.
- Solid mode: paints the entire model with the selected primary color.
- Multiple existing parts: cycles primary / secondary / accent colors through material slots that already exist in the GLB.
- Original image mode: uses the original source image when available.
- Original image + tint: combines source-image detail with the selected primary color.
- Supports Matte / Satin / Glossy / Metallic surface parameters.
- Preserves the original model because Nexa saves the returned GLB as a separate model version.

LIMITATION
The worker does not yet have AI semantic segmentation. If a dog is one mesh with one material, "multiple colors" cannot automatically understand ears vs paws vs nose. Solid color works on the whole object. Semantic part painting can be added as the next layer later.

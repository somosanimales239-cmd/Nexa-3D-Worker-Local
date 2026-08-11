'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
async function writeText(file, text) { await ensureDir(path.dirname(file)); await fsp.writeFile(file, text, 'utf8'); }

function defaultBlenderPaths() {
  return process.platform === 'win32'
    ? [
        'C:/Program Files/Blender Foundation/Blender 4.2/blender.exe',
        'C:/Program Files/Blender Foundation/Blender 4.1/blender.exe',
        'C:/Program Files/Blender Foundation/Blender 4.0/blender.exe',
        'C:/Program Files/Blender Foundation/Blender/blender.exe'
      ]
    : ['blender'];
}

function resolveBlender(customPath = '') {
  const probes = customPath ? [customPath] : defaultBlenderPaths();
  for (const probe of probes) {
    if (probe === 'blender') return probe;
    if (fileExists(probe)) return probe;
  }
  throw new Error('Blender was not found. Install Blender or configure the Blender path.');
}

async function readManifest(bundleDir) {
  const file = path.join(bundleDir, 'manifest.json');
  if (!fileExists(file)) throw new Error('manifest.json was not found in the quick texture bundle.');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function detectFiles(bundleDir, manifest) {
  const model = manifest.model_path ? path.join(bundleDir, manifest.model_path) : path.join(bundleDir, 'model.glb');
  const image = manifest.source_image_path ? path.join(bundleDir, manifest.source_image_path) : path.join(bundleDir, 'source.png');
  const refs = Array.isArray(manifest.reference_images) ? manifest.reference_images.map((x) => path.join(bundleDir, x)).filter(fileExists) : [];
  if (!fileExists(model)) throw new Error('The bundle does not include the input model file.');
  if (!fileExists(image)) throw new Error('The bundle does not include the source image file.');
  return { model, image, refs };
}

function pythonScript(payload) {
  return `
import bpy
import os
import math

input_model = r'''${payload.model}'''
input_image = r'''${payload.image}'''
output_glb = r'''${payload.output}'''
metallic = ${Number(payload.metallic || 0.1)}
roughness = ${Number(payload.roughness || 0.65)}
saturation = ${Number(payload.saturation || 1.15)}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'

bpy.ops.import_scene.gltf(filepath=input_model)
objs = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not objs:
    raise RuntimeError('No mesh objects were found in the input model.')

for obj in objs:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)

img = bpy.data.images.load(input_image)

for obj in objs:
    mat = bpy.data.materials.new(name=f'QuickTexture_{obj.name}')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new(type='ShaderNodeOutputMaterial')
    output.location = (400, 0)
    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.location = (120, 0)
    tex = nodes.new(type='ShaderNodeTexImage')
    tex.location = (-450, 80)
    tex.image = img
    mapping = nodes.new(type='ShaderNodeMapping')
    mapping.location = (-700, 80)
    texcoord = nodes.new(type='ShaderNodeTexCoord')
    texcoord.location = (-950, 80)
    hsv = nodes.new(type='ShaderNodeHueSaturation')
    hsv.location = (-150, 80)
    hsv.inputs[1].default_value = saturation
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness

    links.new(texcoord.outputs['UV'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
    links.new(tex.outputs['Color'], hsv.inputs['Color'])
    links.new(hsv.outputs['Color'], bsdf.inputs['Base Color'])
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    if len(obj.data.materials) == 0:
        obj.data.materials.append(mat)
    else:
        obj.data.materials[0] = mat

bpy.ops.export_scene.gltf(filepath=output_glb, export_format='GLB', export_texcoords=True, export_normals=True, export_materials='EXPORT')
print('Quick texture completed:', output_glb)
`;
}

async function runBlender(blenderExe, pythonFile, cwd, onLog) {
  return await new Promise((resolve, reject) => {
    const child = spawn(blenderExe, ['--background', '--python', pythonFile], { cwd, windowsHide: true });
    child.stdout.on('data', (chunk) => onLog(String(chunk)));
    child.stderr.on('data', (chunk) => onLog(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Blender exited with code ${code}.`)));
  });
}

async function quickTextureJob(options = {}) {
  const bundleDir = path.resolve(String(options.bundleDir || ''));
  const outputDir = path.resolve(String(options.outputDir || path.join(bundleDir, 'output')));
  const blenderExe = resolveBlender(String(options.blenderPath || ''));
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const manifest = await readManifest(bundleDir);
  const files = await detectFiles(bundleDir, manifest);
  await ensureDir(outputDir);
  const output = path.join(outputDir, 'quick-textured.glb');
  const scriptFile = path.join(os.tmpdir(), `nexa-quick-texture-${Date.now()}.py`);
  await writeText(scriptFile, pythonScript({
    model: files.model,
    image: files.image,
    output,
    metallic: manifest.metallic ?? 0.12,
    roughness: manifest.roughness ?? 0.64,
    saturation: manifest.saturation ?? 1.15
  }));
  log(`Running Blender quick texture script with ${blenderExe}`);
  await runBlender(blenderExe, scriptFile, bundleDir, log);
  if (!fileExists(output)) throw new Error('The quick textured GLB was not created.');
  return { output, manifest };
}

module.exports = { quickTextureJob, resolveBlender };

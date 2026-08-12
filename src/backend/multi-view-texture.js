'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBlender } = require('./quick-texture-processor');

function fileExists(file){ try { return fs.statSync(file).isFile(); } catch { return false; } }
async function ensureDir(dir){ await fsp.mkdir(dir, { recursive: true }); }
function py(value){ return String(value || '').replaceAll('\\', '/').replaceAll("'''", "\\'\\'\\'"); }
function compactLog(value, limit = 2400){
  const text = String(value || '').replaceAll('\r', '').trim();
  if (text.length <= limit) return text;
  return text.slice(-limit);
}

function blenderScript(payload){
  const views = JSON.stringify(payload.views || []);
  return `
import bpy, json, math, os, traceback

model_file=r'''${py(payload.model)}'''
output_glb=r'''${py(payload.output)}'''
status_file=r'''${py(payload.statusFile)}'''
views=json.loads(r'''${views}''')
texture_size=${Number(payload.textureSize || 4096)}
polish_level=r'''${py(payload.polishLevel || 'standard')}'''
orientation_mode=r'''${py(payload.orientationMode || 'front_positive_y')}'''
refine_mode=r'''${py(payload.refineMode || 'professional_refine')}'''

POLISH_PRESETS={
    'standard': {'saturation': 1.03, 'value': 1.00, 'contrast': 0.02, 'side_strength': 0.75, 'mask_power': 1.20},
    'high': {'saturation': 1.08, 'value': 1.02, 'contrast': 0.04, 'side_strength': 0.82, 'mask_power': 1.45},
    'professional': {'saturation': 1.12, 'value': 1.03, 'contrast': 0.06, 'side_strength': 0.90, 'mask_power': 1.70},
}
PRESET=POLISH_PRESETS.get(polish_level, POLISH_PRESETS['professional'])


def write_status(ok, message='', detail=''):
    try:
        os.makedirs(os.path.dirname(status_file), exist_ok=True)
        with open(status_file, 'w', encoding='utf-8') as fh:
            json.dump({'ok': bool(ok), 'message': str(message), 'detail': str(detail)}, fh, ensure_ascii=False)
    except Exception:
        pass

try:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=model_file)
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if not meshes:
        raise RuntimeError('No mesh objects found for professional refine texture bake.')

    bpy.ops.object.select_all(action='DESELECT')
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    bpy.ops.object.join()
    obj=bpy.context.active_object
    obj.name='Nexa_Professional_Refine'

    bpy.context.view_layer.objects.active=obj
    obj.select_set(True)
    bpy.ops.object.shade_smooth()
    if hasattr(obj.data, 'use_auto_smooth'):
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(50.0)

    if len(obj.data.uv_layers)==0:
        obj.data.uv_layers.new(name='NexaProfessionalUV')
    obj.data.uv_layers.active_index=0
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02, correct_aspect=True, scale_to_bounds=True)
    except TypeError:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')

    mat=bpy.data.materials.new('Nexa_Professional_Projection_Material')
    mat.use_nodes=True
    tree=mat.node_tree
    nodes=tree.nodes
    links=tree.links
    nodes.clear()

    texcoord=nodes.new('ShaderNodeTexCoord'); texcoord.location=(-1650,100)
    sep_gen=nodes.new('ShaderNodeSeparateXYZ'); sep_gen.location=(-1470,150); links.new(texcoord.outputs['Generated'], sep_gen.inputs['Vector'])
    geom=nodes.new('ShaderNodeNewGeometry'); geom.location=(-1650,-260)
    sep_norm=nodes.new('ShaderNodeSeparateXYZ'); sep_norm.location=(-1470,-260); links.new(geom.outputs['Normal'], sep_norm.inputs['Vector'])

    def projected_color(view_name, filepath, location_y):
        img=bpy.data.images.load(filepath, check_existing=True)
        tex=nodes.new('ShaderNodeTexImage'); tex.image=img; tex.extension='CLIP'; tex.interpolation='Linear'; tex.location=(-760, location_y)
        comb=nodes.new('ShaderNodeCombineXYZ'); comb.location=(-1030, location_y)

        if view_name in ('front','back'):
            links.new(sep_gen.outputs['X'], comb.inputs['X'])
            links.new(sep_gen.outputs['Z'], comb.inputs['Y'])
        else:
            links.new(sep_gen.outputs['Y'], comb.inputs['X'])
            links.new(sep_gen.outputs['Z'], comb.inputs['Y'])

        links.new(comb.outputs['Vector'], tex.inputs['Vector'])

        hue=nodes.new('ShaderNodeHueSaturation'); hue.location=(-520, location_y+40)
        hue.inputs['Saturation'].default_value=PRESET['saturation']
        hue.inputs['Value'].default_value=PRESET['value']
        links.new(tex.outputs['Color'], hue.inputs['Color'])

        bright=nodes.new('ShaderNodeBrightContrast'); bright.location=(-280, location_y+40)
        bright.inputs['Bright'].default_value=0.0
        bright.inputs['Contrast'].default_value=PRESET['contrast']
        links.new(hue.outputs['Color'], bright.inputs['Color'])

        neutral=nodes.new('ShaderNodeRGB'); neutral.outputs[0].default_value=(0.18,0.18,0.19,1.0); neutral.location=(-520, location_y-120)
        mix=nodes.new('ShaderNodeMixRGB'); mix.blend_type='MIX'; mix.location=(-40, location_y+10)
        links.new(neutral.outputs['Color'], mix.inputs[1])
        links.new(bright.outputs['Color'], mix.inputs[2])
        links.new(tex.outputs['Alpha'], mix.inputs[0])
        return mix.outputs['Color']

    def make_mask(axis_socket, invert, location_y, power_value):
        if invert:
            multiply=nodes.new('ShaderNodeMath'); multiply.operation='MULTIPLY'; multiply.inputs[1].default_value=-1.0; multiply.location=(-1020, location_y)
            links.new(axis_socket, multiply.inputs[0])
            axis_socket=multiply.outputs[0]
        bias=nodes.new('ShaderNodeMath'); bias.operation='ADD'; bias.inputs[1].default_value=1.0; bias.location=(-820, location_y)
        scale=nodes.new('ShaderNodeMath'); scale.operation='MULTIPLY'; scale.inputs[1].default_value=0.5; scale.location=(-630, location_y)
        clamp=nodes.new('ShaderNodeMath'); clamp.operation='MAXIMUM'; clamp.inputs[1].default_value=0.0; clamp.location=(-450, location_y)
        power=nodes.new('ShaderNodeMath'); power.operation='POWER'; power.inputs[1].default_value=power_value; power.location=(-250, location_y)
        links.new(axis_socket, bias.inputs[0])
        links.new(bias.outputs[0], scale.inputs[0])
        links.new(scale.outputs[0], clamp.inputs[0])
        links.new(clamp.outputs[0], power.inputs[0])
        return power.outputs[0]

    view_map={v.get('name'):v.get('file') for v in views if v.get('name') and v.get('file') and os.path.isfile(v.get('file'))}
    if 'front' not in view_map:
        raise RuntimeError('Front reference is required for professional refine.')

    front=projected_color('front', view_map['front'], 700)
    back=projected_color('back', view_map['back'], 430) if 'back' in view_map else front

    # Explicit orientation mapping.
    # front_positive_y means the visible front of the character corresponds to +Y normals.
    if orientation_mode == 'front_positive_y':
        front_mask=make_mask(sep_norm.outputs['Y'], False, -50, PRESET['mask_power'])
        back_mask=make_mask(sep_norm.outputs['Y'], True, -220, PRESET['mask_power'])
        left_mask=make_mask(sep_norm.outputs['X'], True, -390, PRESET['mask_power'])
        right_mask=make_mask(sep_norm.outputs['X'], False, -560, PRESET['mask_power'])
    else:
        front_mask=make_mask(sep_norm.outputs['Y'], True, -50, PRESET['mask_power'])
        back_mask=make_mask(sep_norm.outputs['Y'], False, -220, PRESET['mask_power'])
        left_mask=make_mask(sep_norm.outputs['X'], False, -390, PRESET['mask_power'])
        right_mask=make_mask(sep_norm.outputs['X'], True, -560, PRESET['mask_power'])

    front_back_mix=nodes.new('ShaderNodeMixRGB'); front_back_mix.blend_type='MIX'; front_back_mix.location=(240, 610)
    links.new(back, front_back_mix.inputs[1])
    links.new(front, front_back_mix.inputs[2])
    links.new(front_mask, front_back_mix.inputs[0])
    current=front_back_mix.outputs['Color']

    if 'left' in view_map or 'right' in view_map:
        left=projected_color('left', view_map.get('left') or view_map.get('right'), 140)
        right=projected_color('right', view_map.get('right') or view_map.get('left'), -140)
        side_mix=nodes.new('ShaderNodeMixRGB'); side_mix.blend_type='MIX'; side_mix.location=(240, 0)
        links.new(left, side_mix.inputs[1])
        links.new(right, side_mix.inputs[2])
        links.new(right_mask, side_mix.inputs[0])

        abs_x=nodes.new('ShaderNodeMath'); abs_x.operation='ABSOLUTE'; abs_x.location=(240,-430); links.new(sep_norm.outputs['X'], abs_x.inputs[0])
        side_strength=nodes.new('ShaderNodeMath'); side_strength.operation='MULTIPLY'; side_strength.inputs[1].default_value=PRESET['side_strength']; side_strength.location=(430,-430)
        links.new(abs_x.outputs[0], side_strength.inputs[0])

        final_mix=nodes.new('ShaderNodeMixRGB'); final_mix.blend_type='MIX'; final_mix.location=(540, 350)
        links.new(current, final_mix.inputs[1])
        links.new(side_mix.outputs['Color'], final_mix.inputs[2])
        links.new(side_strength.outputs[0], final_mix.inputs[0])
        current=final_mix.outputs['Color']

    out=nodes.new('ShaderNodeOutputMaterial'); out.location=(1140, 40)
    emission=nodes.new('ShaderNodeEmission'); emission.location=(900, 40); emission.inputs['Strength'].default_value=1.0
    links.new(current, emission.inputs['Color'])
    links.new(emission.outputs['Emission'], out.inputs['Surface'])

    baked=bpy.data.images.new('Nexa_Professional_Albedo', width=texture_size, height=texture_size, alpha=False, float_buffer=False)
    bake_node=nodes.new('ShaderNodeTexImage'); bake_node.image=baked; bake_node.location=(760,-140)
    for node in nodes:
        node.select=False
    bake_node.select=True
    nodes.active=bake_node

    obj.data.materials.clear()
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active=obj
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)

    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.device='CPU'
    scene.render.bake.margin=28
    print('NEXA_PRO_REFINE_BAKE_START', texture_size, len(view_map), polish_level, refine_mode)
    bpy.ops.object.bake(type='EMIT', margin=28, use_clear=True)
    print('NEXA_PRO_REFINE_BAKE_DONE')

    texture_file=os.path.join(os.path.dirname(output_glb), 'nexa-professional-albedo.png')
    baked.filepath_raw=texture_file
    baked.file_format='PNG'
    baked.save()
    if not os.path.isfile(texture_file):
        raise RuntimeError('Blender bake completed but the refined albedo PNG was not written.')

    nodes.clear()
    out=nodes.new('ShaderNodeOutputMaterial'); out.location=(680, 0)
    bsdf=nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location=(380, 0)
    if 'Roughness' in bsdf.inputs: bsdf.inputs['Roughness'].default_value=0.56
    if 'Metallic' in bsdf.inputs: bsdf.inputs['Metallic'].default_value=0.0
    final_tex=nodes.new('ShaderNodeTexImage'); final_tex.image=baked; final_tex.location=(-40, 40); final_tex.interpolation='Linear'
    gamma=nodes.new('ShaderNodeGamma'); gamma.location=(160, 40); gamma.inputs['Gamma'].default_value=0.98
    links.new(final_tex.outputs['Color'], gamma.inputs['Color'])
    links.new(gamma.outputs['Color'], bsdf.inputs['Base Color'])
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_glb, export_format='GLB', export_materials='EXPORT', export_texcoords=True, export_normals=True, export_image_format='AUTO')
    if not os.path.isfile(output_glb) or os.path.getsize(output_glb) < 20:
        raise RuntimeError('Blender export finished but the professional refined GLB was not created correctly.')
    write_status(True, 'ok', '')
    print('NEXA_PROFESSIONAL_REFINE_OK', output_glb)
except Exception as exc:
    detail=traceback.format_exc()
    print('NEXA_PROFESSIONAL_REFINE_ERROR', str(exc))
    print(detail)
    write_status(False, str(exc), detail)
`;
}

async function runBlender(executable, script, cwd, statusFile, onLog, onChild){
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--background', '--python', script], { cwd, windowsHide: true, shell: false });
    onChild?.(child);
    let tail = [];
    const log = (chunk) => {
      const text = String(chunk || '').replaceAll('\r', '');
      for (const line of text.split('\n')){
        if (!line.trim()) continue;
        tail.push(line.trim());
        tail = tail.slice(-120);
        onLog?.(line.trim());
      }
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', (err) => { onChild?.(null); reject(err); });
    child.on('close', async (code) => {
      onChild?.(null);
      let status = null;
      try { status = JSON.parse(await fsp.readFile(statusFile, 'utf8')); } catch {}
      if (status?.ok === false){
        const detail = compactLog(status.detail || tail.join('\n'));
        reject(new Error(`Blender professional refine failed: ${status.message || 'Python texture script failed.'}${detail ? `\n${detail}` : ''}`));
        return;
      }
      if (code !== 0){
        reject(new Error(`Blender professional refine exited with code ${code}.${tail.length ? `\n${compactLog(tail.join('\n'))}` : ''}`));
        return;
      }
      resolve({ tail, status });
    });
  });
}

async function bakeAttempt({ model, views, outputDir, blender, textureSize, orientationMode, refineMode, polishLevel, onLog, onChild }){
  const output = path.join(outputDir, 'nexa-professional-refined.glb');
  const statusFile = path.join(outputDir, 'nexa-professional-refine-status.json');
  await fsp.rm(output, { force: true }).catch(() => {});
  await fsp.rm(statusFile, { force: true }).catch(() => {});
  const script = path.join(os.tmpdir(), `nexa-professional-refine-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  await fsp.writeFile(script, blenderScript({ model, views, output, statusFile, textureSize, orientationMode, refineMode, polishLevel }), 'utf8');
  try {
    await runBlender(blender, script, outputDir, statusFile, onLog, onChild);
  } finally {
    await fsp.rm(script, { force: true }).catch(() => {});
  }
  if (!fileExists(output)){
    let diagnostic = '';
    try {
      const status = JSON.parse(await fsp.readFile(statusFile, 'utf8'));
      diagnostic = compactLog(status?.detail || status?.message || '');
    } catch {}
    throw new Error(`Blender finished without creating the professional refined GLB.${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  const stat = await fsp.stat(output);
  if (stat.size < 20) throw new Error('The professional refined GLB is empty or invalid.');
  return { output, textureSize, polishLevel };
}

function memoryFailure(error){
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('out of memory') || text.includes('bad_alloc') || text.includes('cannot allocate') || text.includes('failed to allocate');
}

async function bakeMultiViewTexture(options = {}){
  const model = path.resolve(String(options.model || ''));
  if (!fileExists(model)) throw new Error('Professional refine input model was not found.');
  const views = (Array.isArray(options.views) ? options.views : []).filter(v => v && fileExists(v.file));
  if (!views.find(v => v.name === 'front')) throw new Error('Front reference is required for professional refine.');
  const outputDir = path.resolve(String(options.outputDir || path.dirname(model)));
  await ensureDir(outputDir);
  const blender = resolveBlender(String(options.blenderPath || ''));
  const requested = Math.max(1024, Math.min(4096, Number(options.textureSize || 4096)));
  const orientationMode = String(options.orientationMode || 'front_positive_y');
  const refineMode = String(options.refineMode || 'professional_refine');
  const polishLevel = String(options.polishLevel || (requested >= 4096 ? 'professional' : 'high'));
  try {
    const result = await bakeAttempt({ model, views, outputDir, blender, textureSize: requested, orientationMode, refineMode, polishLevel, onLog: options.onLog, onChild: options.onChild });
    return { ...result, viewCount: views.length, blender, orientationMode };
  } catch (error) {
    if (requested > 2048 && memoryFailure(error)) {
      options.onLog?.('[Professional Refine] 4K bake hit a memory allocation limit. Retrying once at 2048px so the job can finish.');
      const result = await bakeAttempt({ model, views, outputDir, blender, textureSize: 2048, orientationMode, refineMode, polishLevel, onLog: options.onLog, onChild: options.onChild });
      return { ...result, viewCount: views.length, blender, orientationMode, fallbackFrom: requested };
    }
    throw error;
  }
}

module.exports = { bakeMultiViewTexture };

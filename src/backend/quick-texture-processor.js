'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function fileExists(file){try{return fs.statSync(file).isFile();}catch{return false;}}
function dirExists(dir){try{return fs.statSync(dir).isDirectory();}catch{return false;}}
async function ensureDir(dir){await fsp.mkdir(dir,{recursive:true});}

function blenderCandidates(){
  const candidates=[];
  if(process.platform==='win32'){
    const roots=['C:/Program Files/Blender Foundation','C:/Program Files'];
    for(const root of roots){
      if(!dirExists(root)) continue;
      try{
        for(const name of fs.readdirSync(root)){
          if(!name.toLowerCase().startsWith('blender')) continue;
          candidates.push(path.join(root,name,'blender.exe'));
        }
      }catch{}
    }
    candidates.push('C:/Program Files/Blender Foundation/Blender 4.5/blender.exe','C:/Program Files/Blender Foundation/Blender 4.4/blender.exe','C:/Program Files/Blender Foundation/Blender 4.3/blender.exe','C:/Program Files/Blender Foundation/Blender 4.2/blender.exe','C:/Program Files/Blender Foundation/Blender/blender.exe');
  } else candidates.push('blender');
  return [...new Set(candidates)];
}

function resolveBlender(customPath=''){
  const custom=String(customPath||'').trim();
  if(custom){if(fileExists(custom)||custom==='blender')return custom;throw new Error('Configured Blender executable was not found.');}
  for(const candidate of blenderCandidates()) if(candidate==='blender'||fileExists(candidate)) return candidate;
  throw new Error('Blender was not detected. Install Blender or choose blender.exe in Engine Setup.');
}

function probeBlender(customPath=''){
  try{
    const executable=resolveBlender(customPath);
    const result=spawnSync(executable,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});
    const output=String(result.stdout||result.stderr||'').trim();
    if(result.status!==0 && !output) throw new Error('Blender could not be started.');
    const first=output.split(/\r?\n/)[0]||'Blender detected';
    return {ok:true,found:true,executable,version:first};
  }catch(error){return {ok:false,found:false,executable:'',version:'',error:error.message};}
}

async function readManifest(bundleDir){
  const file=path.join(bundleDir,'manifest.json');
  if(!fileExists(file)) throw new Error('manifest.json is missing from the Quick Texture bundle.');
  const parsed=JSON.parse(await fsp.readFile(file,'utf8'));
  if(!parsed||typeof parsed!=='object')throw new Error('Quick Texture manifest is invalid.');
  return parsed;
}

function bundlePath(bundleDir,relative){
  const clean=String(relative||'').replaceAll('\\','/').replace(/^\/+/, '');
  if(!clean)return '';
  const full=path.resolve(bundleDir,...clean.split('/'));
  const root=path.resolve(bundleDir)+path.sep;
  if(full!==path.resolve(bundleDir)&&!full.startsWith(root)) throw new Error('Unsafe bundle path was blocked.');
  return full;
}

async function detectInputs(bundleDir,manifest){
  const model=bundlePath(bundleDir,manifest.model_path||'model.glb');
  if(!fileExists(model))throw new Error('Input model.glb is missing from the Quick Texture bundle.');
  const source=manifest.source_image_path?bundlePath(bundleDir,manifest.source_image_path):'';
  const refs=[];
  for(const ref of Array.isArray(manifest.reference_images)?manifest.reference_images:[]){
    const rel=typeof ref==='string'?ref:ref?.path;
    if(!rel)continue;
    const full=bundlePath(bundleDir,rel);if(fileExists(full))refs.push(full);
  }
  const usableSource=fileExists(source)?source:(refs[0]||'');
  return {model,source:usableSource,refs};
}

function blenderScript(payload){
  return String.raw`
import bpy, os

input_model = r'''${payload.model}'''
source_image = r'''${payload.source}'''
output_glb = r'''${payload.output}'''
object_type = '''${payload.objectType}'''
paint_mode = '''${payload.paintMode}'''
primary_hex = '''${payload.primaryColor}'''
secondary_hex = '''${payload.secondaryColor}'''
accent_hex = '''${payload.accentColor}'''
use_secondary = ${payload.useSecondary ? 'True' : 'False'}
use_accent = ${payload.useAccent ? 'True' : 'False'}
preserve_existing = ${payload.preserveExisting ? 'True' : 'False'}
metallic = ${payload.metallic}
roughness = ${payload.roughness}
saturation = ${payload.saturation}


def srgb_to_linear(v):
    v = max(0.0, min(1.0, v))
    if v <= 0.04045:
        return v / 12.92
    return ((v + 0.055) / 1.055) ** 2.4


def hex_rgba(value):
    value = (value or '#808080').strip().lstrip('#')
    if len(value) != 6:
        value = '808080'
    r = int(value[0:2], 16) / 255.0
    g = int(value[2:4], 16) / 255.0
    b = int(value[4:6], 16) / 255.0
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)

primary = hex_rgba(primary_hex)
secondary = hex_rgba(secondary_hex)
accent = hex_rgba(accent_hex)
colors = [primary]
if use_secondary:
    colors.append(secondary)
if use_accent:
    colors.append(accent)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=input_model)
objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not objects:
    raise RuntimeError('No mesh objects were found in the input GLB.')

src_img = None
if source_image and os.path.isfile(source_image):
    src_img = bpy.data.images.load(source_image, check_existing=True)


def find_principled(mat):
    if not mat.use_nodes:
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for node in nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return node
    out = None
    for node in nodes:
        if node.type == 'OUTPUT_MATERIAL':
            out = node
            break
    if out is None:
        out = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    mat.node_tree.links.new(bsdf.outputs.get('BSDF'), out.inputs.get('Surface'))
    return bsdf


def prepare_surface(bsdf):
    if bsdf.inputs.get('Metallic') is not None:
        bsdf.inputs['Metallic'].default_value = max(0.0, min(1.0, metallic))
    if bsdf.inputs.get('Roughness') is not None:
        bsdf.inputs['Roughness'].default_value = max(0.0, min(1.0, roughness))


def disconnect_base(mat, bsdf):
    base = bsdf.inputs.get('Base Color')
    if base is None:
        return None
    for link in list(base.links):
        mat.node_tree.links.remove(link)
    return base


def paint_color(mat, bsdf, rgba):
    base = disconnect_base(mat, bsdf)
    if base is not None:
        base.default_value = rgba


def existing_color_source(bsdf):
    base = bsdf.inputs.get('Base Color')
    if base is None or not base.links:
        return None
    return base.links[0].from_socket


def connect_source_image(mat, bsdf, tint=None):
    if src_img is None:
        return False
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    base = disconnect_base(mat, bsdf)
    if base is None:
        return False
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = src_img
    tex.projection = 'BOX'
    tex.projection_blend = 0.32
    coord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    hsv = nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = max(0.0, min(2.0, saturation))
    links.new(coord.outputs['Generated'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
    links.new(tex.outputs['Color'], hsv.inputs['Color'])
    source_socket = hsv.outputs['Color']
    if tint is not None:
        mix = nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Fac'].default_value = 1.0
        mix.inputs['Color2'].default_value = tint
        links.new(source_socket, mix.inputs['Color1'])
        source_socket = mix.outputs['Color']
    links.new(source_socket, base)
    return True


def tint_existing_texture(mat, bsdf, tint):
    source_socket = existing_color_source(bsdf)
    if source_socket is None:
        return False
    base = bsdf.inputs.get('Base Color')
    for link in list(base.links):
        mat.node_tree.links.remove(link)
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    mix = nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    mix.inputs['Color2'].default_value = tint
    links.new(source_socket, mix.inputs['Color1'])
    links.new(mix.outputs['Color'], base)
    return True

slot_counter = 0
for obj in objects:
    obj['nexa_object_type'] = object_type
    obj['nexa_quick_texture_mode'] = paint_mode
    if len(obj.data.materials) == 0:
        mat = bpy.data.materials.new(name='Nexa_QuickTexture')
        mat.use_nodes = True
        obj.data.materials.append(mat)

    for slot_index in range(len(obj.data.materials)):
        original_mat = obj.data.materials[slot_index]
        if original_mat is None:
            original_mat = bpy.data.materials.new(name='Nexa_QuickTexture')
            original_mat.use_nodes = True
            obj.data.materials[slot_index] = original_mat

        if paint_mode == 'material_parts':
            mat = original_mat.copy()
            mat.name = 'Nexa_ColorPart_%03d' % (slot_counter + 1)
            obj.data.materials[slot_index] = mat
        else:
            mat = original_mat

        bsdf = find_principled(mat)
        prepare_surface(bsdf)

        if paint_mode == 'solid':
            paint_color(mat, bsdf, primary)
        elif paint_mode == 'material_parts':
            paint_color(mat, bsdf, colors[slot_counter % len(colors)])
        elif paint_mode == 'source_tint':
            if not (preserve_existing and tint_existing_texture(mat, bsdf, primary)):
                if not connect_source_image(mat, bsdf, primary):
                    paint_color(mat, bsdf, primary)
        elif paint_mode == 'source_image':
            if preserve_existing and existing_color_source(bsdf) is not None:
                pass
            elif not connect_source_image(mat, bsdf, None):
                paint_color(mat, bsdf, primary)
        else:
            paint_color(mat, bsdf, primary)
        slot_counter += 1

scene = bpy.context.scene
scene['nexa_object_type'] = object_type
scene['nexa_quick_texture_mode'] = paint_mode
scene['nexa_primary_color'] = primary_hex
scene['nexa_secondary_color'] = secondary_hex if use_secondary else ''
scene['nexa_accent_color'] = accent_hex if use_accent else ''

bpy.ops.export_scene.gltf(filepath=output_glb, export_format='GLB', export_texcoords=True, export_normals=True, export_materials='EXPORT', export_yup=True)
print('NEXA_QUICK_TEXTURE_OK', object_type, paint_mode, output_glb)
`;
}

async function runBlender(executable,script,cwd,onLog,onChild){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['--background','--python',script],{cwd,windowsHide:true,shell:false});
    if(typeof onChild==='function')onChild(child);
    const log=(chunk)=>{const s=String(chunk||'');if(s.trim())onLog(s.trim());};
    child.stdout?.on('data',log);child.stderr?.on('data',log);child.on('error',(error)=>{if(typeof onChild==='function')onChild(null);reject(error)});child.on('close',(code)=>{if(typeof onChild==='function')onChild(null);code===0?resolve():reject(new Error(`Blender Quick Texture exited with code ${code}.`))});
  });
}

async function quickTextureJob(options={}){
  const bundleDir=path.resolve(String(options.bundleDir||''));
  if(!dirExists(bundleDir))throw new Error('Quick Texture bundle directory was not found.');
  const manifest=await readManifest(bundleDir);const inputs=await detectInputs(bundleDir,manifest);
  const outputDir=path.resolve(String(options.outputDir||path.join(bundleDir,'output')));await ensureDir(outputDir);
  const output=path.join(outputDir,'quick-textured.glb');
  const blender=resolveBlender(String(options.blenderPath||''));
  const script=path.join(os.tmpdir(),`nexa-quick-texture-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  const payload={
    model:inputs.model.replaceAll('\\','/'),source:inputs.source.replaceAll('\\','/'),output:output.replaceAll('\\','/'),
    objectType:String(manifest.object_type||'Object').replaceAll("'",''),paintMode:String(manifest.paint_mode||'solid'),
    primaryColor:String(manifest.primary_color||'#8B5E3C'),secondaryColor:String(manifest.secondary_color||'#F2E7D5'),accentColor:String(manifest.accent_color||'#20242A'),
    useSecondary:Boolean(manifest.use_secondary),useAccent:Boolean(manifest.use_accent),preserveExisting:Boolean(manifest.preserve_existing_materials),
    metallic:Number(manifest.metallic??0.0),roughness:Number(manifest.roughness??0.72),saturation:Number(manifest.saturation??1.0)
  };
  await fsp.writeFile(script,blenderScript(payload),'utf8');
  try{await runBlender(blender,script,bundleDir,typeof options.onLog==='function'?options.onLog:()=>{},options.onChild);}finally{await fsp.rm(script,{force:true}).catch(()=>{});}
  if(!fileExists(output))throw new Error('Blender finished without creating quick-textured.glb.');
  const stat=await fsp.stat(output);if(stat.size<20)throw new Error('Quick Texture GLB is empty or invalid.');
  return {output,manifest,blender};
}

module.exports={quickTextureJob,resolveBlender,probeBlender};

'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBlender } = require('./quick-texture-processor');

function fileExists(file){try{return fs.statSync(file).isFile();}catch{return false;}}
async function ensureDir(dir){await fsp.mkdir(dir,{recursive:true});}
function py(value){return String(value||'').replaceAll('\\','/').replaceAll("'''","\\'\\'\\'");}

function blenderScript(payload){
  const views=JSON.stringify(payload.views||[]);
  return `
import bpy, json, math, os

model_file=r'''${py(payload.model)}'''
output_glb=r'''${py(payload.output)}'''
views=json.loads(r'''${views}''')
texture_size=${Number(payload.textureSize||4096)}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=model_file)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
if not meshes:
    raise RuntimeError('No mesh objects found for multi-view texture bake.')

# Join geometry so one UV atlas and one final material are produced.
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes: obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]
bpy.ops.object.join()
obj=bpy.context.active_object
obj.name='Nexa_MultiView_Textured'

# Quality UV atlas.
bpy.context.view_layer.objects.active=obj
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66.0),island_margin=0.025,correct_aspect=True,scale_to_bounds=True)
bpy.ops.object.mode_set(mode='OBJECT')

mat=bpy.data.materials.new('Nexa_MultiView_Baked_Material')
mat.use_nodes=True
nodes=mat.node_tree.nodes
links=mat.node_tree.links
nodes.clear()
out=nodes.new('ShaderNodeOutputMaterial'); out.location=(920,40)
bsdf=nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location=(660,40)
bsdf.inputs['Roughness'].default_value=0.58
bsdf.inputs['Metallic'].default_value=0.0
links.new(bsdf.outputs['BSDF'],out.inputs['Surface'])
texcoord=nodes.new('ShaderNodeTexCoord'); texcoord.location=(-1250,0)
sep_gen=nodes.new('ShaderNodeSeparateXYZ'); sep_gen.location=(-1060,220); links.new(texcoord.outputs['Generated'],sep_gen.inputs['Vector'])
geom=nodes.new('ShaderNodeNewGeometry'); geom.location=(-1250,-280)
sep_norm=nodes.new('ShaderNodeSeparateXYZ'); sep_norm.location=(-1060,-280); links.new(geom.outputs['Normal'],sep_norm.inputs['Vector'])

# Neutral fallback prevents transparent image background from painting black.
def projected_color(view_name, filepath, location_y):
    img=bpy.data.images.load(filepath,check_existing=True)
    tex=nodes.new('ShaderNodeTexImage'); tex.image=img; tex.extension='CLIP'; tex.interpolation='Linear'; tex.location=(-560,location_y)
    comb=nodes.new('ShaderNodeCombineXYZ'); comb.location=(-790,location_y)
    inv=None
    if view_name in ('front','back'):
        x_socket=sep_gen.outputs['X']
        if view_name=='back':
            inv=nodes.new('ShaderNodeMath'); inv.operation='SUBTRACT'; inv.inputs[0].default_value=1.0; inv.location=(-900,location_y+70); links.new(sep_gen.outputs['X'],inv.inputs[1]); x_socket=inv.outputs[0]
        links.new(x_socket,comb.inputs['X']); links.new(sep_gen.outputs['Z'],comb.inputs['Y'])
    else:
        y_socket=sep_gen.outputs['Y']
        if view_name=='left':
            inv=nodes.new('ShaderNodeMath'); inv.operation='SUBTRACT'; inv.inputs[0].default_value=1.0; inv.location=(-900,location_y+70); links.new(sep_gen.outputs['Y'],inv.inputs[1]); y_socket=inv.outputs[0]
        links.new(y_socket,comb.inputs['X']); links.new(sep_gen.outputs['Z'],comb.inputs['Y'])
    links.new(comb.outputs['Vector'],tex.inputs['Vector'])
    neutral=nodes.new('ShaderNodeRGB'); neutral.outputs[0].default_value=(0.16,0.16,0.17,1.0); neutral.location=(-560,location_y-120)
    mix=nodes.new('ShaderNodeMixRGB'); mix.blend_type='MIX'; mix.location=(-280,location_y)
    links.new(neutral.outputs['Color'],mix.inputs[1]); links.new(tex.outputs['Color'],mix.inputs[2]); links.new(tex.outputs['Alpha'],mix.inputs[0])
    return mix.outputs['Color']

view_map={v.get('name'):v.get('file') for v in views if v.get('name') and v.get('file') and os.path.isfile(v.get('file'))}
if 'front' not in view_map:
    raise RuntimeError('Front reference is required for multi-view texturing.')
front=projected_color('front',view_map['front'],520)
back=projected_color('back',view_map['back'],260) if 'back' in view_map else front

# Front/back blend by surface normal Y. Side-facing surfaces receive a balanced mix instead of black.
ny=sep_norm.outputs['Y']
ny_plus=nodes.new('ShaderNodeMath'); ny_plus.operation='ADD'; ny_plus.inputs[1].default_value=1.0; ny_plus.location=(-200,-250); links.new(ny,ny_plus.inputs[0])
ny_half=nodes.new('ShaderNodeMath'); ny_half.operation='MULTIPLY'; ny_half.inputs[1].default_value=0.5; ny_half.location=(0,-250); links.new(ny_plus.outputs[0],ny_half.inputs[0])
fb=nodes.new('ShaderNodeMixRGB'); fb.blend_type='MIX'; fb.location=(80,320); links.new(front,fb.inputs[1]); links.new(back,fb.inputs[2]); links.new(ny_half.outputs[0],fb.inputs[0])
current=fb.outputs['Color']

if 'left' in view_map or 'right' in view_map:
    left=projected_color('left',view_map.get('left') or view_map.get('right'),0)
    right=projected_color('right',view_map.get('right') or view_map.get('left'),-260)
    nx=sep_norm.outputs['X']
    nx_plus=nodes.new('ShaderNodeMath'); nx_plus.operation='ADD'; nx_plus.inputs[1].default_value=1.0; nx_plus.location=(-190,-520); links.new(nx,nx_plus.inputs[0])
    nx_half=nodes.new('ShaderNodeMath'); nx_half.operation='MULTIPLY'; nx_half.inputs[1].default_value=0.5; nx_half.location=(0,-520); links.new(nx_plus.outputs[0],nx_half.inputs[0])
    lr=nodes.new('ShaderNodeMixRGB'); lr.blend_type='MIX'; lr.location=(80,-60); links.new(left,lr.inputs[1]); links.new(right,lr.inputs[2]); links.new(nx_half.outputs[0],lr.inputs[0])
    absx=nodes.new('ShaderNodeMath'); absx.operation='ABSOLUTE'; absx.location=(80,-420); links.new(nx,absx.inputs[0])
    side_strength=nodes.new('ShaderNodeMath'); side_strength.operation='MULTIPLY'; side_strength.inputs[1].default_value=0.90; side_strength.location=(270,-420); links.new(absx.outputs[0],side_strength.inputs[0])
    finalmix=nodes.new('ShaderNodeMixRGB'); finalmix.blend_type='MIX'; finalmix.location=(360,220); links.new(current,finalmix.inputs[1]); links.new(lr.outputs['Color'],finalmix.inputs[2]); links.new(side_strength.outputs[0],finalmix.inputs[0])
    current=finalmix.outputs['Color']

links.new(current,bsdf.inputs['Base Color'])

# Create bake target and bake only diffuse color into a single texture atlas.
baked=bpy.data.images.new('Nexa_MultiView_Albedo',width=texture_size,height=texture_size,alpha=True,float_buffer=False)
bake_node=nodes.new('ShaderNodeTexImage'); bake_node.image=baked; bake_node.location=(390,-120); nodes.active=bake_node; bake_node.select=True
if len(obj.data.materials)==0: obj.data.materials.append(mat)
else:
    obj.data.materials.clear(); obj.data.materials.append(mat)

scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE_NEXT'
# Blender bake requires Cycles; CPU is reliable on systems where CUDA is unavailable.
scene.render.engine='CYCLES'
scene.cycles.device='CPU'
scene.render.bake.use_pass_direct=False
scene.render.bake.use_pass_indirect=False
scene.render.bake.use_pass_color=True
scene.render.bake.margin=18
bpy.context.view_layer.objects.active=obj
obj.select_set(True)
bpy.ops.object.bake(type='DIFFUSE',pass_filter={'COLOR'},margin=18,use_clear=True)

texture_file=os.path.join(os.path.dirname(output_glb),'nexa-multiview-albedo.png')
baked.filepath_raw=texture_file
baked.file_format='PNG'
baked.save()

# Replace projection graph with final baked PBR material.
nodes.clear()
out=nodes.new('ShaderNodeOutputMaterial'); out.location=(420,0)
bsdf=nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location=(160,0); bsdf.inputs['Roughness'].default_value=0.58
final_tex=nodes.new('ShaderNodeTexImage'); final_tex.image=baked; final_tex.location=(-180,30)
links.new(final_tex.outputs['Color'],bsdf.inputs['Base Color']); links.new(bsdf.outputs['BSDF'],out.inputs['Surface'])

os.makedirs(os.path.dirname(output_glb),exist_ok=True)
bpy.ops.export_scene.gltf(filepath=output_glb,export_format='GLB',export_materials='EXPORT',export_texcoords=True,export_normals=True,export_image_format='AUTO')
print('NEXA_MULTI_VIEW_TEXTURE_OK',output_glb)
`;
}

async function runBlender(executable,script,cwd,onLog,onChild){
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,['--background','--python',script],{cwd,windowsHide:true,shell:false});
    onChild?.(child);
    const log=(chunk)=>{const s=String(chunk||'');if(s.trim())onLog?.(s.trim());};
    child.stdout?.on('data',log);child.stderr?.on('data',log);
    child.on('error',(err)=>{onChild?.(null);reject(err);});
    child.on('close',(code)=>{onChild?.(null);code===0?resolve():reject(new Error(`Blender multi-view texture bake exited with code ${code}.`));});
  });
}

async function bakeMultiViewTexture(options={}){
  const model=path.resolve(String(options.model||''));
  if(!fileExists(model))throw new Error('Multi-view texture input model was not found.');
  const views=(Array.isArray(options.views)?options.views:[]).filter(v=>v&&fileExists(v.file));
  if(!views.find(v=>v.name==='front'))throw new Error('Front reference is required for multi-view texture bake.');
  const outputDir=path.resolve(String(options.outputDir||path.dirname(model)));
  await ensureDir(outputDir);
  const output=path.join(outputDir,'nexa-multiview-textured.glb');
  const blender=resolveBlender(String(options.blenderPath||''));
  const script=path.join(os.tmpdir(),`nexa-multiview-texture-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  await fsp.writeFile(script,blenderScript({model,views,output,textureSize:Number(options.textureSize||4096)}),'utf8');
  try{await runBlender(blender,script,outputDir,options.onLog,options.onChild);}finally{await fsp.rm(script,{force:true}).catch(()=>{});}
  if(!fileExists(output))throw new Error('Blender finished without creating the multi-view textured GLB.');
  const stat=await fsp.stat(output); if(stat.size<20)throw new Error('The multi-view textured GLB is empty or invalid.');
  return {output,viewCount:views.length,textureSize:Number(options.textureSize||4096),blender};
}

module.exports={bakeMultiViewTexture};

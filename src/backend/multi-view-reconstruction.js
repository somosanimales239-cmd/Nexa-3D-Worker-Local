'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBlender } = require('./quick-texture-processor');

function fileExists(file){try{return fs.statSync(file).isFile();}catch{return false;}}
async function ensureDir(dir){await fsp.mkdir(dir,{recursive:true});}

function pyString(value){return String(value||'').replaceAll('\\','/').replaceAll("'''","\\'\\'\\'");}

function blenderScript(payload){
  const viewsJson = JSON.stringify(payload.views || []);
  return `
import bpy, json, math, os
from mathutils import Vector

views = json.loads(r'''${viewsJson}''')
output_glb = r'''${pyString(payload.output)}'''

bpy.ops.wm.read_factory_settings(use_empty=True)

def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']

def world_bbox(objects):
    pts=[]
    for obj in objects:
        for corner in obj.bound_box:
            pts.append(obj.matrix_world @ Vector(corner))
    if not pts:
        return Vector((0,0,0)), Vector((1,1,1))
    lo=Vector((min(p.x for p in pts),min(p.y for p in pts),min(p.z for p in pts)))
    hi=Vector((max(p.x for p in pts),max(p.y for p in pts),max(p.z for p in pts)))
    return lo,hi

def normalize_group(objects, target_height=2.0):
    lo,hi=world_bbox(objects)
    size=hi-lo
    height=max(size.z,1e-6)
    scale=target_height/height
    center=(lo+hi)/2
    for obj in objects:
        obj.scale = tuple(v*scale for v in obj.scale)
    bpy.context.view_layer.update()
    lo2,hi2=world_bbox(objects)
    center2=(lo2+hi2)/2
    ground=lo2.z
    for obj in objects:
        obj.location.x -= center2.x
        obj.location.y -= center2.y
        obj.location.z -= ground
    bpy.context.view_layer.update()

all_meshes=[]
for i,view in enumerate(views):
    before=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=view['file'])
    imported=[o for o in bpy.data.objects if o not in before and o.type=='MESH']
    if not imported:
        continue
    normalize_group(imported,2.0)
    angle=float(view.get('rotation_z',0.0))
    for obj in imported:
        obj.rotation_euler.rotate_axis('Z', math.radians(angle))
        obj['nexa_view']=view.get('name','view')
        all_meshes.append(obj)
    bpy.context.view_layer.update()

if not all_meshes:
    raise RuntimeError('No mesh objects were imported for multi-view reconstruction.')

# Join all view reconstructions, then use Blender voxel remesh to create one coherent shell.
bpy.ops.object.select_all(action='DESELECT')
for obj in all_meshes:
    obj.select_set(True)
bpy.context.view_layer.objects.active=all_meshes[0]
bpy.ops.object.join()
joined=bpy.context.active_object
joined.name='Nexa_MultiView_Reconstruction'

lo,hi=world_bbox([joined])
diagonal=max((hi-lo).length,1e-4)
# Quality-first voxel size. Fine enough to retain silhouette details while remaining practical on CPU.
joined.data.remesh_voxel_size=max(diagonal/360.0,0.0025)
joined.data.remesh_voxel_adaptivity=0.0
joined.data.use_remesh_fix_poles=True
joined.data.use_remesh_preserve_volume=True
bpy.context.view_layer.objects.active=joined
joined.select_set(True)
bpy.ops.object.voxel_remesh()

# Smooth the fused shell without erasing silhouette.
for poly in joined.data.polygons:
    poly.use_smooth=True

# Rebuild normals.
bpy.context.view_layer.objects.active=joined
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Keep a practical web model size while prioritizing shape detail.
poly_count=len(joined.data.polygons)
if poly_count>260000:
    modifier=joined.modifiers.new(name='NexaQualityDecimate',type='DECIMATE')
    modifier.ratio=max(0.45,260000.0/poly_count)
    bpy.context.view_layer.objects.active=joined
    bpy.ops.object.modifier_apply(modifier=modifier.name)

os.makedirs(os.path.dirname(output_glb),exist_ok=True)
bpy.ops.export_scene.gltf(filepath=output_glb,export_format='GLB',export_materials='EXPORT',export_normals=True,export_texcoords=True)
print('NEXA_MULTI_VIEW_RECONSTRUCTION_OK',output_glb)
`;
}

async function runBlender(executable,script,cwd,onLog,onChild){
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,['--background','--python',script],{cwd,windowsHide:true,shell:false});
    onChild?.(child);
    const log=(chunk)=>{const s=String(chunk||'');if(s.trim())onLog?.(s.trim());};
    child.stdout?.on('data',log);child.stderr?.on('data',log);
    child.on('error',(err)=>{onChild?.(null);reject(err);});
    child.on('close',(code)=>{onChild?.(null);code===0?resolve():reject(new Error(`Blender multi-view reconstruction exited with code ${code}.`));});
  });
}

async function fuseMultiViewGeometry(options={}){
  const views=Array.isArray(options.views)?options.views.filter(v=>v&&fileExists(v.file)):[];
  if(!views.length)throw new Error('No generated view meshes were available for multi-view reconstruction.');
  if(views.length===1)return {output:views[0].file,viewCount:1,blender:null};
  const outputDir=path.resolve(String(options.outputDir||path.dirname(views[0].file)));
  await ensureDir(outputDir);
  const output=path.join(outputDir,'nexa-multiview-reconstructed.glb');
  const blender=resolveBlender(String(options.blenderPath||''));
  const script=path.join(os.tmpdir(),`nexa-multiview-reconstruct-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  await fsp.writeFile(script,blenderScript({views,output}),'utf8');
  try{
    await runBlender(blender,script,outputDir,options.onLog,options.onChild);
  }finally{
    await fsp.rm(script,{force:true}).catch(()=>{});
  }
  if(!fileExists(output))throw new Error('Blender finished without creating the multi-view reconstruction GLB.');
  const stat=await fsp.stat(output);
  if(stat.size<20)throw new Error('The multi-view reconstruction GLB is empty or invalid.');
  return {output,viewCount:views.length,blender};
}

module.exports={fuseMultiViewGeometry};

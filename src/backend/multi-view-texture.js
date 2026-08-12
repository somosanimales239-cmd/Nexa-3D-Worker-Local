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
function compactLog(value,limit=2400){
  const text=String(value||'').replaceAll('\r','').trim();
  if(text.length<=limit)return text;
  return text.slice(-limit);
}

function blenderScript(payload){
  const views=JSON.stringify(payload.views||[]);
  return `
import bpy, json, math, os, sys, traceback

model_file=r'''${py(payload.model)}'''
output_glb=r'''${py(payload.output)}'''
status_file=r'''${py(payload.statusFile)}'''
views=json.loads(r'''${views}''')
texture_size=${Number(payload.textureSize||4096)}

def write_status(ok, message='', detail=''):
    try:
        os.makedirs(os.path.dirname(status_file), exist_ok=True)
        with open(status_file, 'w', encoding='utf-8') as fh:
            json.dump({'ok': bool(ok), 'message': str(message), 'detail': str(detail)}, fh, ensure_ascii=False)
    except Exception:
        pass

def fail(message):
    detail=traceback.format_exc()
    print('NEXA_MULTI_VIEW_TEXTURE_ERROR', message)
    print(detail)
    write_status(False, message, detail)
    raise RuntimeError(message)

try:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=model_file)
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if not meshes:
        raise RuntimeError('No mesh objects found for multi-view texture bake.')

    # Join to one shell so the final GLB has one UV atlas and one PBR material.
    bpy.ops.object.select_all(action='DESELECT')
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    bpy.ops.object.join()
    obj=bpy.context.active_object
    obj.name='Nexa_MultiView_Textured'

    # A fresh UV map avoids relying on UV state inherited from the reconstruction GLB.
    bpy.context.view_layer.objects.active=obj
    obj.select_set(True)
    if len(obj.data.uv_layers)==0:
        obj.data.uv_layers.new(name='NexaMultiViewUV')
    obj.data.uv_layers.active_index=0
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02, correct_aspect=True, scale_to_bounds=True)
    except TypeError:
        # Compatibility fallback for Blender builds exposing the reduced Smart UV signature.
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')

    mat=bpy.data.materials.new('Nexa_MultiView_Projection_Material')
    mat.use_nodes=True
    tree=mat.node_tree
    nodes=tree.nodes
    links=tree.links
    nodes.clear()

    texcoord=nodes.new('ShaderNodeTexCoord'); texcoord.location=(-1280,40)
    sep_gen=nodes.new('ShaderNodeSeparateXYZ'); sep_gen.location=(-1090,220); links.new(texcoord.outputs['Generated'],sep_gen.inputs['Vector'])
    geom=nodes.new('ShaderNodeNewGeometry'); geom.location=(-1280,-300)
    sep_norm=nodes.new('ShaderNodeSeparateXYZ'); sep_norm.location=(-1090,-300); links.new(geom.outputs['Normal'],sep_norm.inputs['Vector'])

    def projected_color(view_name, filepath, location_y):
        img=bpy.data.images.load(filepath,check_existing=True)
        tex=nodes.new('ShaderNodeTexImage'); tex.image=img; tex.extension='CLIP'; tex.interpolation='Linear'; tex.location=(-560,location_y)
        comb=nodes.new('ShaderNodeCombineXYZ'); comb.location=(-800,location_y)
        if view_name in ('front','back'):
            x_socket=sep_gen.outputs['X']
            if view_name=='back':
                inv=nodes.new('ShaderNodeMath'); inv.operation='SUBTRACT'; inv.inputs[0].default_value=1.0; inv.location=(-930,location_y+70)
                links.new(sep_gen.outputs['X'],inv.inputs[1]); x_socket=inv.outputs[0]
            links.new(x_socket,comb.inputs['X']); links.new(sep_gen.outputs['Z'],comb.inputs['Y'])
        else:
            y_socket=sep_gen.outputs['Y']
            if view_name=='left':
                inv=nodes.new('ShaderNodeMath'); inv.operation='SUBTRACT'; inv.inputs[0].default_value=1.0; inv.location=(-930,location_y+70)
                links.new(sep_gen.outputs['Y'],inv.inputs[1]); y_socket=inv.outputs[0]
            links.new(y_socket,comb.inputs['X']); links.new(sep_gen.outputs['Z'],comb.inputs['Y'])
        links.new(comb.outputs['Vector'],tex.inputs['Vector'])
        neutral=nodes.new('ShaderNodeRGB'); neutral.outputs[0].default_value=(0.16,0.16,0.17,1.0); neutral.location=(-560,location_y-125)
        mix=nodes.new('ShaderNodeMixRGB'); mix.blend_type='MIX'; mix.location=(-290,location_y)
        links.new(neutral.outputs['Color'],mix.inputs[1]); links.new(tex.outputs['Color'],mix.inputs[2]); links.new(tex.outputs['Alpha'],mix.inputs[0])
        return mix.outputs['Color']

    view_map={v.get('name'):v.get('file') for v in views if v.get('name') and v.get('file') and os.path.isfile(v.get('file'))}
    if 'front' not in view_map:
        raise RuntimeError('Front reference is required for multi-view texturing.')

    front=projected_color('front',view_map['front'],540)
    back=projected_color('back',view_map['back'],280) if 'back' in view_map else front

    # Surface-normal weighting: front and back remain separate instead of smearing one photo around the shell.
    ny=sep_norm.outputs['Y']
    ny_plus=nodes.new('ShaderNodeMath'); ny_plus.operation='ADD'; ny_plus.inputs[1].default_value=1.0; ny_plus.location=(-220,-240); links.new(ny,ny_plus.inputs[0])
    ny_half=nodes.new('ShaderNodeMath'); ny_half.operation='MULTIPLY'; ny_half.inputs[1].default_value=0.5; ny_half.location=(-20,-240); links.new(ny_plus.outputs[0],ny_half.inputs[0])
    fb=nodes.new('ShaderNodeMixRGB'); fb.blend_type='MIX'; fb.location=(80,330); links.new(front,fb.inputs[1]); links.new(back,fb.inputs[2]); links.new(ny_half.outputs[0],fb.inputs[0])
    current=fb.outputs['Color']

    if 'left' in view_map or 'right' in view_map:
        left=projected_color('left',view_map.get('left') or view_map.get('right'),10)
        right=projected_color('right',view_map.get('right') or view_map.get('left'),-260)
        nx=sep_norm.outputs['X']
        nx_plus=nodes.new('ShaderNodeMath'); nx_plus.operation='ADD'; nx_plus.inputs[1].default_value=1.0; nx_plus.location=(-200,-520); links.new(nx,nx_plus.inputs[0])
        nx_half=nodes.new('ShaderNodeMath'); nx_half.operation='MULTIPLY'; nx_half.inputs[1].default_value=0.5; nx_half.location=(0,-520); links.new(nx_plus.outputs[0],nx_half.inputs[0])
        lr=nodes.new('ShaderNodeMixRGB'); lr.blend_type='MIX'; lr.location=(80,-50); links.new(left,lr.inputs[1]); links.new(right,lr.inputs[2]); links.new(nx_half.outputs[0],lr.inputs[0])
        absx=nodes.new('ShaderNodeMath'); absx.operation='ABSOLUTE'; absx.location=(80,-420); links.new(nx,absx.inputs[0])
        side_strength=nodes.new('ShaderNodeMath'); side_strength.operation='MULTIPLY'; side_strength.inputs[1].default_value=0.90; side_strength.location=(270,-420); links.new(absx.outputs[0],side_strength.inputs[0])
        finalmix=nodes.new('ShaderNodeMixRGB'); finalmix.blend_type='MIX'; finalmix.location=(360,220); links.new(current,finalmix.inputs[1]); links.new(lr.outputs['Color'],finalmix.inputs[2]); links.new(side_strength.outputs[0],finalmix.inputs[0])
        current=finalmix.outputs['Color']

    # Bake an emission pass. This transfers the projection color itself and avoids DIFFUSE/pass-filter
    # compatibility differences and lighting contamination in recent Blender releases.
    out=nodes.new('ShaderNodeOutputMaterial'); out.location=(760,40)
    emission=nodes.new('ShaderNodeEmission'); emission.location=(520,40); emission.inputs['Strength'].default_value=1.0
    links.new(current,emission.inputs['Color']); links.new(emission.outputs['Emission'],out.inputs['Surface'])

    baked=bpy.data.images.new('Nexa_MultiView_Albedo',width=texture_size,height=texture_size,alpha=False,float_buffer=False)
    bake_node=nodes.new('ShaderNodeTexImage'); bake_node.image=baked; bake_node.location=(360,-190)
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
    scene.render.bake.margin=24
    print('NEXA_MULTI_VIEW_TEXTURE_BAKE_START', texture_size, len(view_map))
    bpy.ops.object.bake(type='EMIT', margin=24, use_clear=True)
    print('NEXA_MULTI_VIEW_TEXTURE_BAKE_DONE')

    texture_file=os.path.join(os.path.dirname(output_glb),'nexa-multiview-albedo.png')
    baked.filepath_raw=texture_file
    baked.file_format='PNG'
    baked.save()
    if not os.path.isfile(texture_file):
        raise RuntimeError('Blender bake completed but the 4K albedo PNG was not written.')

    # Replace temporary projection nodes with a portable glTF PBR material using the baked atlas.
    nodes.clear()
    out=nodes.new('ShaderNodeOutputMaterial'); out.location=(460,0)
    bsdf=nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location=(190,0)
    if 'Roughness' in bsdf.inputs: bsdf.inputs['Roughness'].default_value=0.58
    if 'Metallic' in bsdf.inputs: bsdf.inputs['Metallic'].default_value=0.0
    final_tex=nodes.new('ShaderNodeTexImage'); final_tex.image=baked; final_tex.location=(-180,30); final_tex.interpolation='Linear'
    links.new(final_tex.outputs['Color'],bsdf.inputs['Base Color']); links.new(bsdf.outputs['BSDF'],out.inputs['Surface'])

    os.makedirs(os.path.dirname(output_glb),exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_glb,export_format='GLB',export_materials='EXPORT',export_texcoords=True,export_normals=True,export_image_format='AUTO')
    if not os.path.isfile(output_glb) or os.path.getsize(output_glb) < 20:
        raise RuntimeError('Blender export finished but the textured GLB was not created correctly.')
    write_status(True, 'ok', '')
    print('NEXA_MULTI_VIEW_TEXTURE_OK',output_glb)
except Exception as exc:
    detail=traceback.format_exc()
    print('NEXA_MULTI_VIEW_TEXTURE_ERROR', str(exc))
    print(detail)
    write_status(False, str(exc), detail)
`;
}

async function runBlender(executable,script,cwd,statusFile,onLog,onChild){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['--background','--python',script],{cwd,windowsHide:true,shell:false});
    onChild?.(child);
    let tail=[];
    const log=(chunk)=>{
      const text=String(chunk||'').replaceAll('\r','');
      for(const line of text.split('\n')){
        if(!line.trim())continue;
        tail.push(line.trim());
        tail=tail.slice(-120);
        onLog?.(line.trim());
      }
    };
    child.stdout?.on('data',log);
    child.stderr?.on('data',log);
    child.on('error',(err)=>{onChild?.(null);reject(err);});
    child.on('close',async(code)=>{
      onChild?.(null);
      let status=null;
      try{status=JSON.parse(await fsp.readFile(statusFile,'utf8'));}catch{}
      if(status?.ok===false){
        const detail=compactLog(status.detail||tail.join('\n'));
        reject(new Error(`Blender multi-view texture failed: ${status.message||'Python texture script failed.'}${detail?`\n${detail}`:''}`));
        return;
      }
      if(code!==0){
        reject(new Error(`Blender multi-view texture bake exited with code ${code}.${tail.length?`\n${compactLog(tail.join('\n'))}`:''}`));
        return;
      }
      resolve({tail,status});
    });
  });
}

async function bakeAttempt({model,views,outputDir,blender,textureSize,onLog,onChild}){
  const output=path.join(outputDir,'nexa-multiview-textured.glb');
  const statusFile=path.join(outputDir,'nexa-multiview-texture-status.json');
  await fsp.rm(output,{force:true}).catch(()=>{});
  await fsp.rm(statusFile,{force:true}).catch(()=>{});
  const script=path.join(os.tmpdir(),`nexa-multiview-texture-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  await fsp.writeFile(script,blenderScript({model,views,output,statusFile,textureSize}),'utf8');
  try{
    await runBlender(blender,script,outputDir,statusFile,onLog,onChild);
  }finally{
    await fsp.rm(script,{force:true}).catch(()=>{});
  }
  if(!fileExists(output)){
    let diagnostic='';
    try{
      const status=JSON.parse(await fsp.readFile(statusFile,'utf8'));
      diagnostic=compactLog(status?.detail||status?.message||'');
    }catch{}
    throw new Error(`Blender finished without creating the multi-view textured GLB.${diagnostic?`\n${diagnostic}`:''}`);
  }
  const stat=await fsp.stat(output);
  if(stat.size<20)throw new Error('The multi-view textured GLB is empty or invalid.');
  return {output,textureSize};
}

function memoryFailure(error){
  const text=String(error?.message||error||'').toLowerCase();
  return text.includes('out of memory')||text.includes('bad_alloc')||text.includes('cannot allocate')||text.includes('failed to allocate');
}

async function bakeMultiViewTexture(options={}){
  const model=path.resolve(String(options.model||''));
  if(!fileExists(model))throw new Error('Multi-view texture input model was not found.');
  const views=(Array.isArray(options.views)?options.views:[]).filter(v=>v&&fileExists(v.file));
  if(!views.find(v=>v.name==='front'))throw new Error('Front reference is required for multi-view texture bake.');
  const outputDir=path.resolve(String(options.outputDir||path.dirname(model)));
  await ensureDir(outputDir);
  const blender=resolveBlender(String(options.blenderPath||''));
  const requested=Math.max(1024,Math.min(4096,Number(options.textureSize||4096)));
  try{
    const result=await bakeAttempt({model,views,outputDir,blender,textureSize:requested,onLog:options.onLog,onChild:options.onChild});
    return {...result,viewCount:views.length,blender};
  }catch(error){
    if(requested>2048 && memoryFailure(error)){
      options.onLog?.(`[Multi-View Texture] 4K bake hit a memory allocation limit. Retrying once at 2048px so the job can finish.`);
      const result=await bakeAttempt({model,views,outputDir,blender,textureSize:2048,onLog:options.onLog,onChild:options.onChild});
      return {...result,viewCount:views.length,blender,fallbackFrom:requested};
    }
    throw error;
  }
}

module.exports={bakeMultiViewTexture};

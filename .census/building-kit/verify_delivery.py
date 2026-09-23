"""Final offline acceptance measurements for delivered building packages."""
from pathlib import Path
import json,subprocess,struct,hashlib,sys,math
KIT=Path(__file__).parent
TOKTX=r'e:\Scoop\shims\ktx.exe'
names=sys.argv[1:] or [n for n in json.loads((KIT/'ratings.json').read_text()) if n!='longhouse']
def glb(path):
    raw=path.read_bytes();n=struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+n]),raw[28+n:]
allreports={}
for name in names:
    root=KIT.parent/name;reports={}
    for label,folder,size in [('original',root,2048),('low',root/'low',1024)]:
        v=json.loads((folder/'verification.json').read_text());assert v['passed'],name
        assert abs(v['bounds_gltf_y_up']['min'][1])<.00001,(name,'ground contact')
        assert v['primitive_count']==1 and v['uv_min_max'][0]>=0 and v['uv_min_max'][1]<=1
        d=v['texel_density_min_max'];assert all(math.isfinite(x) and x>0 for x in d) and d[1]/d[0]<1.005,(name,d)
        assert v['blend']['mesh_count']==1 and v['blend']['material_count']==1 and v['blend']['images_packed']
        doc,blob=glb(folder/(name+'.glb'));rd,rb=glb(folder/(name+'-ktx2.glb'))
        png_metadata={}
        for kind in ('basecolor','normal','metallicRoughness'):
            data=(folder/(name+'-'+kind+'.png')).read_bytes()
            assert data[:8]==b'\x89PNG\r\n\x1a\n'
            width,height,depth,channels=struct.unpack_from('>IIBB',data,16)
            assert (width,height,depth,channels)==(size,size,8,2)
            cursor=8;chunks=[]
            while cursor<len(data):
                length=struct.unpack_from('>I',data,cursor)[0];chunks.append(data[cursor+4:cursor+8]);cursor+=length+12
            assert (b'sRGB' in chunks)==(kind=='basecolor')
            png_metadata[kind]={'dimensions':[size,size],'channels':'RGB','bits':8,'srgb_tag':b'sRGB' in chunks}
        assert len(doc['images'])==len(rd['images'])==3
        assert doc['meshes']==rd['meshes'] and doc['accessors']==rd['accessors'] and doc['nodes']==rd['nodes']
        assert 'KHR_texture_basisu' in rd['extensionsRequired']
        assert not any(e in str(rd) for e in ['KHR_draco_mesh_compression','EXT_meshopt_compression'])
        for a in doc['accessors']:
            ov=doc['bufferViews'][a['bufferView']];nv=rd['bufferViews'][a['bufferView']]
            assert blob[ov.get('byteOffset',0):ov.get('byteOffset',0)+ov['byteLength']]==rb[nv.get('byteOffset',0):nv.get('byteOffset',0)+nv['byteLength']]
        meta={}
        for im in rd['images']:
            path=folder/(im['name']+'.ktx2')
            info=json.loads(subprocess.check_output([TOKTX,'info','--format','json',str(path)]))
            descriptor=info['dataFormatDescriptor']['blocks'][0]
            srgb='basecolor' in im['name']
            assert descriptor['colorModel']=='KHR_DF_MODEL_UASTC'
            assert descriptor['transferFunction']==('KHR_DF_TRANSFER_SRGB' if srgb else 'KHR_DF_TRANSFER_LINEAR')
            assert descriptor['samples'][0]['channelType']=='KHR_DF_CHANNEL_UASTC_RGB'
            assert 'KTXswizzle' not in info['keyValueData']
            assert info['header']['pixelWidth']==info['header']['pixelHeight']==size
            assert info['header']['levelCount']==int(math.log2(size))+1
            assert len(info['index']['levels'])==info['header']['levelCount']
            assert all(level['byteLength']>0 for level in info['index']['levels'])
            view=rd['bufferViews'][im['bufferView']]
            assert rb[view['byteOffset']:view['byteOffset']+view['byteLength']]==path.read_bytes()
            meta[im['name']]={'transfer':descriptor['transferFunction'],'model':descriptor['colorModel'],'channels':descriptor['samples'][0]['channelType'],'mip_levels':info['header']['levelCount'],'orientation':info['keyValueData'].get('KTXorientation'),'swizzle':None}
        for texture in rd['textures']:
            assert 'source' not in texture
            assert rd['images'][texture['extensions']['KHR_texture_basisu']['source']]['mimeType']=='image/ktx2'
        reports[label]={'passed':True,'png_metadata':png_metadata,'ktx_metadata':meta,'geometry_and_hierarchy_unchanged':True,'texel_density_relative_spread':d[1]/d[0]-1,'glb_sha256':hashlib.sha256((folder/(name+'.glb')).read_bytes()).hexdigest()}
    original=json.loads((root/'verification.json').read_text());low=json.loads((root/'low'/'verification.json').read_text())
    assert low['triangles']<original['triangles'],name
    delta=max(abs(a-b) for bound in ('min','max') for a,b in zip(original['bounds_gltf_y_up'][bound],low['bounds_gltf_y_up'][bound]))
    assert delta<.0002,(name,delta)
    reports['lod_bounds_delta']=delta
    reports['passed']=True
    (root/'delivery-verification.json').write_text(json.dumps(reports,indent=2))
    allreports[name]=reports
    print('VERIFIED',name,flush=True)
(KIT/'delivery-summary.json').write_text(json.dumps(allreports,indent=2))

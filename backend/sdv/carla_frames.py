"""Binary JPEG envelope for the private native CARLA bridge (no base64 copies)."""
import json
import struct

MEDIA_TYPE='application/vnd.sdv.carla-frames'


def pack_frames(state, events, frames):
    header=json.dumps(dict(state=state,events=events,frames=[dict(view=view,stamp=stamp,size=len(jpeg)) for view,stamp,jpeg in frames]),separators=(',',':')).encode()
    return b''.join([struct.pack('<I',len(header)),header,*(jpeg for _,_,jpeg in frames)])


def unpack_frames(data):
    if len(data)<4:raise ValueError('Truncated CARLA frame envelope')
    size=struct.unpack_from('<I',data)[0]
    if size>2_000_000 or size>len(data)-4:raise ValueError('Invalid CARLA frame header')
    header=json.loads(data[4:4+size]);offset=4+size;frames=[]
    for frame in header['frames']:
        length=frame['size']
        if frame['view'] not in ('driver','chase') or not isinstance(frame['stamp'],int) or frame['stamp']<0:
            raise ValueError('Invalid CARLA camera metadata')
        if not isinstance(length,int) or not 0<length<=12_000_000 or offset+length>len(data):
            raise ValueError('Invalid CARLA camera payload')
        frames.append((frame['view'],frame['stamp'],data[offset:offset+length]));offset+=length
    if offset!=len(data):raise ValueError('Trailing CARLA frame payload')
    return header['state'],header['events'],frames

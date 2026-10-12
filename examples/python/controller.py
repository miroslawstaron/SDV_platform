"""Alternate conservative controller, using the same process contract."""
import json
import sys
from sdv.application import compute
for line in sys.stdin:
    ctx=json.loads(line)
    result=compute('controller',ctx)
    result['can'][0][1]['Acceleration']=min(1.0,result['can'][0][1]['Acceleration'])
    print(json.dumps(result),flush=True)

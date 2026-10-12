import json
import sys
from pathlib import Path
from .models import ModuleManifest,RunRequest,RouteRequest
def main():
    target=Path(sys.argv[1] if len(sys.argv)>1 else '/app/contracts/schemas');target.mkdir(parents=True,exist_ok=True)
    for name,model in [('module',ModuleManifest),('scenario',RunRequest),('route-request',RouteRequest)]:
        (target/(name+'.schema.json')).write_text(json.dumps(model.model_json_schema(),indent=2))
if __name__=='__main__':main()

FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONPATH=/app:/usr/share/sumo/tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv sumo=1.18.0+dfsg-3build5 sumo-tools=1.18.0+dfsg-3build5 ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# Ubuntu's SUMO 1.18 netconvert build aborts on some valid OSM junction angles.
# Keep the simulator pinned and use the official release converter of the same version.
RUN pip install --no-cache-dir --target /opt/netconvert-release eclipse-sumo==1.18.0
ENV NETCONVERT_BINARY=/opt/netconvert-release/sumo/bin/netconvert
WORKDIR /app
COPY contracts /app/contracts
COPY backend /app
COPY examples /app/examples
RUN curl -fL https://github.com/COVESA/vehicle_signal_specification/releases/download/v6.1/vss.json -o /app/contracts/vss.json
RUN python3 -m grpc_tools.protoc -I contracts --python_out=sdv --grpc_python_out=sdv contracts/adapter.proto && sed -i 's/^import adapter_pb2/from . import adapter_pb2/' sdv/adapter_pb2_grpc.py
CMD ["uvicorn", "sdv.api:app", "--host", "0.0.0.0", "--port", "8000"]

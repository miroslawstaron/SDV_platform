FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git curl unzip libboost-all-dev libgrpc++-dev protobuf-compiler-grpc libprotobuf-dev && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fL https://github.com/vectorgrp/sil-kit/releases/download/v5.0.7/SilKit-5.0.7-ubuntu-24.04-x86_64-gcc.zip -o /tmp/silkit.zip && unzip /tmp/silkit.zip -d /opt/silkit && rm /tmp/silkit.zip
RUN git clone --depth 1 --branch 3.7.6 https://github.com/COVESA/vsomeip.git /tmp/vsomeip
COPY native/patch-vsomeip.py /tmp/patch-vsomeip.py
RUN python3 /tmp/patch-vsomeip.py && cmake -S /tmp/vsomeip -B /tmp/vsomeip/build -DCMAKE_BUILD_TYPE=Release -DENABLE_SIGNAL_HANDLING=1 -DBUILD_TESTING=OFF && cmake --build /tmp/vsomeip/build -j 4 && cmake --install /tmp/vsomeip/build
COPY native /src/native
COPY contracts /src/contracts
COPY examples /src/examples
RUN cmake -S /src/native -B /src/build -DCMAKE_BUILD_TYPE=Release -DSilKit_DIR=$(dirname $(find /opt/silkit -name SilKitConfig.cmake | head -1)) && cmake --build /src/build -j 4
FROM python-runtime
COPY --from=build /usr/local/lib /usr/local/lib
COPY --from=build /tmp/vsomeip/implementation/routing/src/routing_manager_impl.cpp /usr/share/sdv/upstream/routing_manager_impl.cpp
COPY --from=build /tmp/vsomeip/LICENSE /usr/share/sdv/upstream/vsomeip-LICENSE
COPY --from=build /opt/silkit /opt/silkit
COPY --from=build /src/build/sdv-adapter /usr/local/bin/
COPY --from=build /src/build/example-controller /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends libgrpc++1.51t64 libprotobuf32t64 libboost-system1.83.0 libboost-thread1.83.0 && rm -rf /var/lib/apt/lists/* && find /opt/silkit -name libSilKit.so -exec cp {} /usr/local/lib/ \; && find /opt/silkit -name sil-kit-registry -exec cp {} /usr/local/bin/ \; && ldconfig
CMD ["uvicorn", "sdv.worker:app", "--host", "0.0.0.0", "--port", "8000"]

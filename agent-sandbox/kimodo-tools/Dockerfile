# kimodo-tools — rig-finalisation worker.
#
# Wraps three existing CLI tools behind one HTTP endpoint:
#   1. unirig_mapping.py    derives a bone table from a UniRig-rigged GLB
#   2. glb_palms_down.py    Blender bake: rotate wrists, apply armature,
#                           pose-as-rest, re-bind, export
#   3. import_unirig_glb.py register the palms-down GLB into kimodo's
#                           .kimodo-characters/ registry
#
# Bind-mounted at runtime (see docker-compose.yml):
#   /workspace          shared with pi-bridge (character dirs live here)
#   /kimodo             host path to the kimodo repo (scripts + registry)
#   /woid-scripts       host path to woid scripts (provides glb_palms_down.py)
#
# Why the official Blender tarball, not the Debian package: the
# packaged blender 3.4 uses np.bool inside its bundled glTF addon,
# which was removed from numpy 1.20+ — and Python 3.11 doesn't
# accept old-enough numpy. The official tarball ships its own
# bundled Python + numpy, sidestepping the conflict entirely.
FROM python:3.11-bookworm

ARG BLENDER_VERSION=4.2.4
ARG BLENDER_MAJOR=4.2
ARG BLENDER_TGZ_URL=https://download.blender.org/release/Blender${BLENDER_MAJOR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz

# Blender headless deps (X11 stubs even though we run --background;
# Blender's binary still links against them).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 \
        libxkbcommon0 libsm6 libdbus-1-3 \
        xz-utils curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "${BLENDER_TGZ_URL}" -o /tmp/blender.tar.xz \
 && mkdir -p /opt \
 && tar -xJf /tmp/blender.tar.xz -C /opt \
 && rm /tmp/blender.tar.xz \
 && mv "/opt/blender-${BLENDER_VERSION}-linux-x64" /opt/blender \
 && ln -s /opt/blender/blender /usr/local/bin/blender

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py /app/

EXPOSE 8082
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8082"]

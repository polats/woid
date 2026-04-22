#!/usr/bin/env bash
# Install nvidia-container-toolkit so `docker run --gpus all` works.
# One-time setup. Requires sudo.
#
# Run end-to-end:  sudo bash scripts/install-nvidia-container-toolkit.sh
# Or copy-paste the blocks below one at a time.

set -euo pipefail

# 1. Add NVIDIA's apt repo
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# 2. Install + wire into docker
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 3. Smoke test — should print nvidia-smi output from inside the container
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi

# Ubuntu 25.10 note: if the external repo install fails on deps, try the
# distro package instead:
#   sudo apt install -y nvidia-container-toolkit   # from Ubuntu multiverse

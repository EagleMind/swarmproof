#!/bin/bash
#
# Bootstrap a fresh Amazon Linux 2023 box into a running engine.
#
# Pass this as EC2 user-data. It is idempotent enough to re-run by hand, and
# its output lands in /var/log/cloud-init-output.log.
#
# What this deliberately does NOT do is expose the engine. The API binds
# loopback inside the instance; deploy/nginx-engine.conf is what faces the
# network, and it refuses anything without the shared secret. See deploy/README.md.
#
set -euxo pipefail

# No default: there is no shared control plane. Set CONTROL_PLANE to your own
# `npm run worker:deploy` output to enable shared health, or leave it unset and
# the engine runs fully local.
CONTROL_PLANE="${CONTROL_PLANE:-}"

dnf update -y
dnf install -y docker git nginx

systemctl enable --now docker

# t3.small is under 2 GiB and verification opens many sockets at once. Swap
# turns a spike that would OOM-kill the engine into a spike that is merely slow.
if ! swapon --show | grep -q swapfile; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

git clone https://github.com/EagleMind/swarmproof.git /opt/swarmproof
cd /opt/swarmproof

# The Dockerfile already sets ENGINE_HOST=0.0.0.0 / ENGINE_ALLOW_PUBLIC=1 and
# moves the working directory onto /app/state, so the DHT routing table and
# peer cache survive the container being replaced.
docker build -t swarmproof:latest .
docker volume create engine-state

# Published on loopback ONLY. The engine has no authentication of its own, so
# this port must never face the internet directly.
#
# Log rotation is not optional: the default json-file driver is unbounded, and
# an engine that logs steadily will eventually fill the root volume.
docker run -d \
  --name swarmproof \
  --restart unless-stopped \
  --log-opt max-size=20m --log-opt max-file=3 \
  -p 127.0.0.1:8080:8080 \
  -v engine-state:/app/state \
  -e "SWARMPROOF_API=$CONTROL_PLANE" \
  swarmproof:latest

echo "bootstrap-complete $(date -Is)" > /var/log/swarmproof-bootstrap.done

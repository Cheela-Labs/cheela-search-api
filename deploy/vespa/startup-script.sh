#!/usr/bin/env bash
#
# GCE startup script for the Cheela Search Vespa node.
#
# Runs on every boot, not just the first, so everything here is idempotent.
#
# The one property worth reading carefully is the publish address. Vespa's
# query and deploy ports are bound to the VM's *internal* address, discovered
# from the metadata server, rather than to 0.0.0.0. The VM has an external
# address only so it can pull the image, and a firewall rule already restricts
# 8080/19071 to the subnet — but binding to the internal interface means an
# accidentally permissive firewall rule still finds nothing listening on the
# public side. Two independent things have to be wrong before Vespa is exposed.
set -euo pipefail

VESPA_IMAGE="vespaengine/vespa:8.738.17"
DATA_DIR=/var/lib/vespa
LOG_DIR=/var/log/vespa

log() { echo "[vespa-startup] $*"; }

if ! command -v docker >/dev/null 2>&1; then
	log "installing docker"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y -qq docker.io
fi

systemctl enable --now docker

mkdir -p "$DATA_DIR" "$LOG_DIR"
# Vespa runs as uid 1000 inside the container. A bind mount keeps the host's
# ownership, so without this the container starts as root, drops to vespa, and
# dies on `permission denied` writing its own log directory — which surfaces as
# a Go panic in vespa-start-configserver rather than as anything about volumes.
chown -R 1000:1000 "$DATA_DIR" "$LOG_DIR"

INTERNAL_IP=$(curl -sf -H "Metadata-Flavor: Google" \
	"http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip")
if [[ -z "${INTERNAL_IP}" ]]; then
	log "could not read the internal IP from the metadata server; refusing to bind 0.0.0.0"
	exit 1
fi
log "internal address is ${INTERNAL_IP}"

# "Running" is not the same question as "working": a crash-looping container
# spends part of every cycle reporting Running, so a check that trusts it will
# happily leave a broken Vespa in place forever. Ask the config server instead.
if curl -sf --max-time 5 "http://${INTERNAL_IP}:19071/state/v1/health" >/dev/null 2>&1; then
	log "already up and answering; nothing to do"
	exit 0
fi

docker rm -f vespa >/dev/null 2>&1 || true

log "starting ${VESPA_IMAGE}"
# The ulimits are Vespa's documented minimums. Without them the content node
# starts and then dies under its own file descriptor use, which looks like a
# corrupt index rather than a misconfigured host.
docker run --detach --name vespa \
	--hostname vespa-node \
	--publish "${INTERNAL_IP}:8080:8080" \
	--publish "${INTERNAL_IP}:19071:19071" \
	--volume "${DATA_DIR}:/opt/vespa/var" \
	--volume "${LOG_DIR}:/opt/vespa/logs" \
	--ulimit nofile=262144:262144 \
	--ulimit nproc=409600:409600 \
	--restart unless-stopped \
	"${VESPA_IMAGE}"

log "waiting for the config server"
for _ in $(seq 1 60); do
	if curl -sf "http://${INTERNAL_IP}:19071/state/v1/health" >/dev/null 2>&1; then
		log "config server is up"
		exit 0
	fi
	sleep 5
done

log "config server did not come up within 5 minutes; see docker logs vespa"
exit 1

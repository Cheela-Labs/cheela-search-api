#!/usr/bin/env bash
#
# Deploys the Vespa application package.
#
#   bash vespa/deploy.sh                 # to docker compose on localhost
#   bash vespa/deploy.sh --via-iap       # to the production VM
#
# Both modes end up running vespa/apply.sh *next to the config server*. That is
# the whole design: the package has to contain a 90MB ONNX model, and the
# difference between downloading it on the VM and pushing it up an IAP tunnel
# is seconds versus tens of minutes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT="${PROJECT:-project-9c03937c-a376-48cb-ba8}"
ZONE="${ZONE:-asia-southeast1-a}"
VM="${VM:-cheela-vespa}"

if [[ "${1:-}" != "--via-iap" ]]; then
	exec bash "${here}/apply.sh"
fi

echo "==> copying the package to ${VM}"
# Everything except the model cache, which is per-host by design.
tarball=$(mktemp -u).tar.gz
tar -czf "$tarball" -C "$here" \
	--exclude=.model-cache \
	services.xml schemas validation-overrides.xml apply.sh

gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap \
	--command="rm -rf /tmp/vespa-package && mkdir -p /tmp/vespa-package" >/dev/null

gcloud compute scp "$tarball" "${VM}:/tmp/vespa-package/package.tar.gz" \
	--zone="$ZONE" --project="$PROJECT" --tunnel-through-iap >/dev/null
rm -f "$tarball"

echo "==> applying on ${VM}"
# The cache lives outside /tmp so a reboot does not cost another 90MB download.
gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="
	set -euo pipefail
	cd /tmp/vespa-package
	tar -xzf package.tar.gz
	sudo mkdir -p /var/cache/vespa-models
	sudo chown \$(id -u):\$(id -g) /var/cache/vespa-models
	VESPA_MODEL_CACHE=/var/cache/vespa-models \
	VESPA_CONFIG_ENDPOINT=http://10.148.0.2:19071 \
		bash apply.sh
" 2>&1 | grep -vE "NumPy|^please see|^WARNING: *$"

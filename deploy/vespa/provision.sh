#!/usr/bin/env bash
#
# Provisions the production dependencies Cheela Search cannot run without:
# a Vespa node, a Redis instance, a bucket for raw fetched HTML, and the
# firewall rules that keep the first two off the public internet.
#
# Idempotent: every step checks for what it is about to create. Safe to re-run
# after a partial failure.
#
# This costs money. Roughly $64/mo for the VM and its disk, $38/mo for
# Memorystore. Read deployment.md before running it on a project you care about.
set -euo pipefail

PROJECT="${PROJECT:-project-9c03937c-a376-48cb-ba8}"
REGION="${REGION:-asia-southeast1}"
ZONE="${ZONE:-asia-southeast1-a}"
NETWORK="${NETWORK:-default}"
# The subnet Cloud Run's direct VPC egress allocates from, and therefore the
# only source range that needs to reach Vespa.
SUBNET_RANGE="${SUBNET_RANGE:-10.148.0.0/20}"
VM="${VM:-cheela-vespa}"
REDIS="${REDIS:-cheela-redis}"
BUCKET="${BUCKET:-${PROJECT}_${REGION}_search-raw}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { echo; echo "==> $*"; }
have() { gcloud "$@" >/dev/null 2>&1; }

say "APIs"
gcloud services enable redis.googleapis.com compute.googleapis.com \
	storage.googleapis.com secretmanager.googleapis.com --project="$PROJECT"

say "Redis (Memorystore basic, 1GB)"
if have redis instances describe "$REDIS" --region="$REGION" --project="$PROJECT"; then
	echo "already exists"
else
	gcloud redis instances create "$REDIS" --project="$PROJECT" --region="$REGION" \
		--size=1 --tier=basic --redis-version=redis_7_2 \
		--network="projects/${PROJECT}/global/networks/${NETWORK}" \
		--connect-mode=DIRECT_PEERING
fi

say "Firewall"
# Deny is the default on a VPC, so these two rules are the entire ingress
# surface: Vespa from the Cloud Run subnet, SSH from IAP's range only. There is
# deliberately no rule with source 0.0.0.0/0.
if have compute firewall-rules describe allow-vespa-internal --project="$PROJECT"; then
	echo "allow-vespa-internal already exists"
else
	gcloud compute firewall-rules create allow-vespa-internal --project="$PROJECT" \
		--network="$NETWORK" --direction=INGRESS --action=ALLOW \
		--rules=tcp:8080,tcp:19071 --source-ranges="$SUBNET_RANGE" \
		--target-tags=vespa \
		--description="Vespa query and deploy ports, reachable only from the Cloud Run subnet"
fi
if have compute firewall-rules describe allow-ssh-iap --project="$PROJECT"; then
	echo "allow-ssh-iap already exists"
else
	gcloud compute firewall-rules create allow-ssh-iap --project="$PROJECT" \
		--network="$NETWORK" --direction=INGRESS --action=ALLOW --rules=tcp:22 \
		--source-ranges=35.235.240.0/20 \
		--description="SSH via Identity-Aware Proxy only; no public SSH"
fi

say "Vespa VM"
if have compute instances describe "$VM" --zone="$ZONE" --project="$PROJECT"; then
	echo "already exists"
else
	gcloud compute instances create "$VM" --project="$PROJECT" --zone="$ZONE" \
		--machine-type=e2-standard-2 \
		--image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
		--boot-disk-size=50GB --boot-disk-type=pd-balanced \
		--tags=vespa \
		--metadata-from-file="startup-script=${here}/startup-script.sh" \
		--scopes=logging-write,monitoring-write
fi

say "Raw HTML bucket"
if have storage buckets describe "gs://${BUCKET}" --project="$PROJECT"; then
	echo "already exists"
else
	# Uniform access, and a lifecycle rule: the archive exists so extraction can
	# be re-run without re-crawling, which is worth 90 days and not worth forever.
	gcloud storage buckets create "gs://${BUCKET}" --project="$PROJECT" \
		--location="$REGION" --uniform-bucket-level-access
	tmp=$(mktemp)
	cat >"$tmp" <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}
JSON
	gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$tmp"
	rm -f "$tmp"
fi

say "Where things landed"
gcloud compute instances describe "$VM" --zone="$ZONE" --project="$PROJECT" \
	--format='value[separator="  "](name,networkInterfaces[0].networkIP,status)'
gcloud redis instances describe "$REDIS" --region="$REGION" --project="$PROJECT" \
	--format='value[separator="  "](name,host,port,state)' 2>/dev/null || echo "redis still creating"
echo "bucket  gs://${BUCKET}"
echo
echo "Next: set VESPA_ENDPOINT to http://<vespa internal IP>:8080 and REDIS_URL"
echo "to redis://<redis host>:6379 in Secret Manager, then vespa/deploy.sh."

#!/usr/bin/env bash
#
# This service has nothing to schedule.
#
# It used to put `search-api-worker` and `search-api-scheduler` on timers. Both
# Jobs are gone: ingestion moved to apps/search-console (ADR-003), and
# `worker.ts` and `scheduler.ts` went with it. The schedules outlived the Jobs
# they pointed at, which is worse than having none — Cloud Scheduler kept
# reporting them, and a job that fails to trigger a target that does not exist
# looks like a permissions problem.
#
# Everything that runs on a timer now lives in apps/search-console/deploy/schedule.sh:
# verify, manifest-sync, crawl, embed and learn.
#
# This script's remaining job is to remove what it created. It is safe to run
# more than once and safe to run when there is nothing to remove.
set -euo pipefail

PROJECT="${PROJECT:-project-9c03937c-a376-48cb-ba8}"
REGION="${REGION:-asia-southeast1}"

echo "==> Removing schedules for Jobs this service no longer has"

for name in search-api-worker-tick search-api-crawl-plan; do
	if gcloud scheduler jobs describe "$name" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
		gcloud scheduler jobs delete "$name" --location="$REGION" --project="$PROJECT" --quiet
		echo "  removed $name"
	else
		echo "  $name is already gone"
	fi
done

echo
echo "==> Remaining schedules in this project"
gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
	--format='table(name.basename(),schedule,state)' 2>/dev/null || true

#!/usr/bin/env bash
#
# Puts the two background Jobs on a timer.
#
# **Run this after the first successful deploy**, not before. Cloud Scheduler
# validates the target at creation, and a schedule pointing at a Cloud Run Job
# that does not exist yet fails with a permissions error that reads like an IAM
# problem rather than a missing job. cloudbuild.yaml creates the Jobs; this points
# a clock at them.
#
# Idempotent: each schedule is created or updated.
set -euo pipefail

PROJECT="${PROJECT:-project-9c03937c-a376-48cb-ba8}"
REGION="${REGION:-asia-southeast1}"
SA="${SA:-search-api@${PROJECT}.iam.gserviceaccount.com}"

# Cloud Scheduler invokes the Cloud Run Admin API rather than the job directly.
run_uri() {
	echo "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/$1:run"
}

schedule() {
	local name="$1" job="$2" cron="$3" description="$4"

	local verb=create
	if gcloud scheduler jobs describe "$name" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
		verb=update
	fi

	gcloud scheduler jobs "$verb" http "$name" \
		--project="$PROJECT" \
		--location="$REGION" \
		--schedule="$cron" \
		--time-zone=Etc/UTC \
		--uri="$(run_uri "$job")" \
		--http-method=POST \
		--oauth-service-account-email="$SA" \
		--description="$description" \
		--attempt-deadline=30s \
		--max-retry-attempts=1
	echo "  ${verb}d ${name} (${cron})"
}

echo "==> Scheduling"

# Every five minutes. The worker drains the event streams and exits, so this is
# the indexing latency: a page a query discovered is in the index within about
# five minutes. That is the trade decision 04 in PLAN.md makes deliberately —
# always-allocated CPU for a stream consumer is ~$46/month and the user never
# waits for indexing.
#
# The interval is not a throughput limit: WORKER_DRAIN_MS gives each run four
# minutes, and a run that finds nothing exits in seconds.
schedule search-api-worker-tick search-api-worker "*/5 * * * *" \
	"Drain the Cheela Search event streams: fetch, extract, index, update the graph"

# Hourly. Recomputing crawl priorities is a decision about what to fetch next,
# and demand is measured over 30 days — it does not move meaningfully in an hour,
# let alone five minutes.
schedule search-api-crawl-plan search-api-scheduler "17 * * * *" \
	"Recompute demand-driven crawl priorities and promote the frontier"

echo
echo "==> Scheduled jobs"
gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
	--format='table(name.basename(),schedule,state)' 2>/dev/null | grep -E "search-api|NAME" || true

echo
echo "To run one immediately:"
echo "  gcloud scheduler jobs run search-api-worker-tick --location=${REGION}"
echo "To stop one without deleting it:"
echo "  gcloud scheduler jobs pause search-api-worker-tick --location=${REGION}"

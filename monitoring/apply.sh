#!/usr/bin/env bash
#
# Applies the log-based metric and the dashboard that PLAN.md's step 7 accepts
# against. Idempotent: run it as often as you like.
#
#   ./monitoring/apply.sh [PROJECT_ID]
#
# Not wired into cloudbuild.yaml, and that is deliberate. These are two
# project-level objects that change roughly never, while the build runs on every
# push — putting them there would mean every deploy needs permission to rewrite
# the monitoring configuration, which is a much wider grant than shipping a
# container needs. See Decision 02 on why this service's identity is kept
# narrow.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
METRIC="search_api_cache_lookup"
DASHBOARD_NAME="Search — cache economics"

if [ -z "$PROJECT" ]; then
	echo "No project. Pass one, or run: gcloud config set project PROJECT_ID" >&2
	exit 1
fi

echo "Project: $PROJECT"

# ---------------------------------------------------------------------------
# The metric.
#
# A log-based metric only counts lines ingested *after* it exists — it does not
# backfill. So this runs before the deploy that starts emitting them, and a
# dashboard that is empty for the first few minutes is working correctly.
# ---------------------------------------------------------------------------
if gcloud logging metrics describe "$METRIC" --project="$PROJECT" >/dev/null 2>&1; then
	echo "Updating log-based metric $METRIC"
	gcloud logging metrics update "$METRIC" \
		--config-from-file="$DIR/cache-lookup-metric.yaml" \
		--project="$PROJECT"
else
	echo "Creating log-based metric $METRIC"
	gcloud logging metrics create "$METRIC" \
		--config-from-file="$DIR/cache-lookup-metric.yaml" \
		--project="$PROJECT"
fi

# ---------------------------------------------------------------------------
# The dashboard.
#
# Matched by display name because its resource id is generated at creation and
# is not something a repo can know in advance.
# ---------------------------------------------------------------------------
EXISTING="$(gcloud monitoring dashboards list \
	--project="$PROJECT" \
	--format='value(name)' \
	--filter="displayName=\"$DASHBOARD_NAME\"" 2>/dev/null | head -1)"

if [ -n "$EXISTING" ]; then
	echo "Updating dashboard $EXISTING"
	gcloud monitoring dashboards update "$EXISTING" \
		--config-from-file="$DIR/cache-dashboard.json" \
		--project="$PROJECT"
else
	echo "Creating dashboard \"$DASHBOARD_NAME\""
	gcloud monitoring dashboards create \
		--config-from-file="$DIR/cache-dashboard.json" \
		--project="$PROJECT"
fi

echo
echo "Dashboards: https://console.cloud.google.com/monitoring/dashboards?project=$PROJECT"

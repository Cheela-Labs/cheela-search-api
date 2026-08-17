#!/usr/bin/env bash
#
# Assembles the application package and activates it. Runs on the host that
# can reach the config server directly — localhost in dev, the VM in
# production — which is the point: the cross-encoder ONNX is ~90MB and has to
# be *inside* the package, so it is downloaded here rather than pushed through
# a deploy tunnel from a laptop.
#
# Called by vespa/deploy.sh. Runnable on its own if you are already on the box.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG_ENDPOINT="${VESPA_CONFIG_ENDPOINT:-http://127.0.0.1:19071}"
CROSS_ENCODER_URL="https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model.onnx"
# Outside the package, so re-deploying does not re-download 90MB.
CACHE="${VESPA_MODEL_CACHE:-${here}/.model-cache}"

mkdir -p "$CACHE"
if [[ ! -s "${CACHE}/cross_encoder.onnx" ]]; then
	echo "==> downloading the cross-encoder (~90MB, once)"
	curl -sSL --fail --max-time 600 -o "${CACHE}/cross_encoder.onnx.part" "$CROSS_ENCODER_URL"
	mv "${CACHE}/cross_encoder.onnx.part" "${CACHE}/cross_encoder.onnx"
fi

pkg=$(mktemp -d)
cp "${here}/services.xml" "$pkg/"
cp -r "${here}/schemas" "$pkg/"
[[ -f "${here}/validation-overrides.xml" ]] && cp "${here}/validation-overrides.xml" "$pkg/"
mkdir -p "${pkg}/models"
cp "${CACHE}/cross_encoder.onnx" "${pkg}/models/cross_encoder.onnx"

zipfile="${pkg}.zip"
# python's zipfile rather than `zip`, which is not installed on the CI image,
# the VM, or a stock Alpine.
(cd "$pkg" && python3 -c "
import pathlib, zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(pathlib.Path('.').rglob('*')):
        if p.is_file():
            z.write(p, p.as_posix())
" "$zipfile")

echo "==> deploying $(du -h "$zipfile" | cut -f1) to ${CONFIG_ENDPOINT}"
response=$(curl -sS --max-time 900 \
	--header "Content-Type: application/zip" \
	--data-binary "@${zipfile}" \
	"${CONFIG_ENDPOINT}/application/v2/tenant/default/prepareandactivate")

rm -rf "$pkg" "$zipfile"

echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"

# The config server answers 200 with a JSON body describing the failure for a
# whole class of errors, so the HTTP status alone does not tell you what
# happened.
if echo "$response" | grep -qE '"(error-code|errors)"'; then
	echo "DEPLOY FAILED" >&2
	exit 1
fi

echo "==> activated; waiting for the query container"
query_endpoint="${CONFIG_ENDPOINT%:19071}:8080"
for _ in $(seq 1 120); do
	if curl -sf --max-time 5 "${query_endpoint}/ApplicationStatus" >/dev/null 2>&1; then
		echo "==> up: ${query_endpoint}"
		exit 0
	fi
	sleep 5
done

echo "activated, but the query container did not answer within 10 minutes." >&2
echo "It may still be downloading the embedder models; check ApplicationStatus." >&2
exit 1

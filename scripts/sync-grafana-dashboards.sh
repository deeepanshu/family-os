#!/usr/bin/env bash
# Publish this repo's Grafana dashboards to the observability stack.
#
# Runs as the Komodo stack `post_deploy` hook on the apps host, from the repo
# clone, after a successful compose up. Grafana's file provider polls the
# destination directory, so no reload call or admin credentials are needed.
#
# Replaces the dashboard-sync half of the retired homelab-manager.
set -euo pipefail

SRC_DIR="${SRC_DIR:-grafana/dashboards}"
DEST_HOST="${DEST_HOST:-192.168.1.66}"
DEST_DIR="${DEST_DIR:-/opt/homelab/observability/grafana/provisioning/dashboards/files/apps}"

if [ ! -d "${SRC_DIR}" ]; then
  echo "No ${SRC_DIR} directory; nothing to publish."
  exit 0
fi

shopt -s nullglob
files=("${SRC_DIR}"/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "No dashboards in ${SRC_DIR}; nothing to publish."
  exit 0
fi

echo "Publishing ${#files[@]} dashboard(s) to ${DEST_HOST}:${DEST_DIR}"

for file in "${files[@]}"; do
  name="$(basename "${file}")"
  # Validate JSON before shipping; a malformed dashboard makes Grafana skip it.
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "${file}"
  scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${file}" "root@${DEST_HOST}:${DEST_DIR}/${name}"
  echo "  -> ${name}"
done

echo "Published. Grafana picks these up on its next provisioning poll."

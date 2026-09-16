#!/bin/sh
set -eu

# Firebase configuration stays out of source control. Xcode Cloud provides it
# as a redacted base64 environment variable immediately before archive/build.
if [ "${CI_XCODE_CLOUD:-FALSE}" != "TRUE" ]; then
  exit 0
fi

if [ -z "${FIREBASE_GOOGLE_SERVICE_INFO_PLIST_BASE64:-}" ]; then
  echo "error: FIREBASE_GOOGLE_SERVICE_INFO_PLIST_BASE64 is required for Xcode Cloud builds" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
config_path="${script_dir}/../FamilyOS/Resources/GoogleService-Info.plist"
temp_path="$(mktemp)"
trap 'rm -f "$temp_path"' EXIT
umask 077

printf '%s' "$FIREBASE_GOOGLE_SERVICE_INFO_PLIST_BASE64" | base64 -D > "$temp_path"
plutil -lint "$temp_path" >/dev/null
mv "$temp_path" "$config_path"

if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  echo "error: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required for Xcode Cloud builds" >&2
  exit 1
fi

metrics_config_path="${script_dir}/../Config/Release.private.xcconfig"
umask 077
{
  printf '\nCF_ACCESS_CLIENT_ID = %s\n' "$CF_ACCESS_CLIENT_ID"
  printf 'CF_ACCESS_CLIENT_SECRET = %s\n' "$CF_ACCESS_CLIENT_SECRET"
} >> "$metrics_config_path"

echo "OTLP metrics configuration restored for Xcode Cloud build"
trap - EXIT

echo "Firebase configuration restored for Xcode Cloud build"

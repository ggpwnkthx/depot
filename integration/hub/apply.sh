#!/usr/bin/env bash
# Applies the extension of the hub to a checkout (spec §5).
#
#   ./integration/hub/apply.sh /path/to/hub
#
# The script refuses a checkout that is not at the pinned revision: the
# patch is written against that revision and it is not a patch against
# "something close".

set -euo pipefail

HUB_COMMIT="fd5a97a3138d516af2daaf75497ee70b7738593d"
PATCH="$(cd "$(dirname "$0")" && pwd)/0001-access-context-contract.patch"

if [ $# -lt 1 ]; then
  echo "the path of the checkout of the hub is required" >&2
  exit 1
fi

HUB_DIRECTORY="$1"

if [ ! -d "${HUB_DIRECTORY}/.git" ]; then
  echo "${HUB_DIRECTORY} is not a git checkout" >&2
  exit 1
fi

CURRENT="$(git -C "${HUB_DIRECTORY}" rev-parse HEAD)"
if [ "${CURRENT}" != "${HUB_COMMIT}" ]; then
  echo "the checkout is at ${CURRENT} and the patch is written against ${HUB_COMMIT}" >&2
  echo "check out the pinned revision first:" >&2
  echo "  git -C ${HUB_DIRECTORY} checkout ${HUB_COMMIT}" >&2
  exit 1
fi

git -C "${HUB_DIRECTORY}" apply --check "${PATCH}"
git -C "${HUB_DIRECTORY}" apply "${PATCH}"

echo "the patch is applied to ${HUB_DIRECTORY}"
echo "run the tests of the hub:"
echo "  cd ${HUB_DIRECTORY} && bun install && bun test"

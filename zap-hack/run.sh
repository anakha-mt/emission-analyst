#!/usr/bin/env bash
# Boot the emission demo locally: tool server (:9001) + ZAP platform (:3000).
#
#   ./run.sh
#
# Then open http://localhost:3000/zap and ask an emissions question.
set -euo pipefail
cd "$(dirname "$0")"

# The emission widget schemas/fixtures are imported from the `widgets` submodule
# (../widgets -> 0north/zap-widgets@zap-dev-wave). Make sure it's checked out, and
# that the schemas' only runtime dep (zod) is installed at the repo root so Node can
# resolve it from inside ../widgets/src (the submodule ships no node_modules).
git -C .. submodule update --init widgets
[ -d ../node_modules/zod ] || (cd .. && npm install --no-audit --no-fund)

# zap-cli needs Node >=24; this machine defaults to 18, so pin via nvm.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null

# stage-tier secrets come from SSM under this AWS SSO profile.
export AWS_PROFILE="${AWS_PROFILE:-zn-stage}"
aws sts get-caller-identity --profile "$AWS_PROFILE" >/dev/null 2>&1 \
  || { echo "AWS SSO session expired — run: aws sso login --profile $AWS_PROFILE"; exit 1; }

# 1) tool server (background)
npx tsx server/index.ts &
TOOL_PID=$!
trap 'kill "$TOOL_PID" 2>/dev/null || true' EXIT
sleep 1

# 2) platform — reads the spec once at startup, so it must boot after the tool server
zap serve

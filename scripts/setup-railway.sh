#!/usr/bin/env bash
set -euo pipefail

# One-command automated Railway setup for InControl Daily Context Archive
# Provisions PostgreSQL + daily-archive service in your own Railway account
# and configures ~/.incontrol/settings.json automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org and re-run this script."
  exit 1
fi

echo ""
echo "InControl -> Automated Railway Daily Archive Setup"
echo "--------------------------------------------------"
echo "This will:"
echo "  1. Install the Railway CLI (if missing)"
echo "  2. Open your browser once to sign in / create a Railway account"
echo "  3. Deploy PostgreSQL + InControl Collector in your own Railway project"
echo "  4. Connect InControl automatically (no manual token copy-paste)"
echo ""

exec node "$ROOT_DIR/bin/incontrol.js" setup railway "$@"

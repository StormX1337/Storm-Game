#!/bin/sh
# Lokale Entwicklung ohne Docker: Redis + PostgreSQL müssen laufen.
set -e
export PYTHONPATH="${PYTHONPATH:-.}"

case "${1:-help}" in
  api)      exec python -m backend.api ;;
  scanner)  exec python -m backend.scanner ;;
  telegram) exec python -m backend.telegram ;;
  migrate)  exec alembic upgrade head ;;
  test)     exec pytest "${@:2}" ;;
  lint)     ruff check backend && exec ruff format --check backend ;;
  *)
    echo "Verwendung: scripts/dev.sh {api|scanner|telegram|migrate|test|lint}"
    exit 1
    ;;
esac

# syntax=docker/dockerfile:1
#
# Ein Image für alle drei Python-Dienste (api, scanner, telegram-bot).
# Unterschieden wird nur über das Kommando in der docker-compose.yml -
# das hält Build-Zeit und Registry klein und garantiert identische Deps.

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Europe/Berlin

WORKDIR /app

# --------------------------------------------------------------- Builder
FROM base AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r requirements.txt

# --------------------------------------------------------------- Runtime
FROM base AS runtime

# Kein Root: der Anwendungsbenutzer besitzt nichts außer dem Code.
RUN groupadd --gid 10001 storm \
    && useradd --uid 10001 --gid storm --create-home --shell /usr/sbin/nologin storm

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app

COPY --chown=storm:storm alembic.ini pyproject.toml requirements-dev.txt ./
COPY --chown=storm:storm backend ./backend
COPY --chown=storm:storm scripts ./scripts

RUN chmod +x scripts/*.sh 2>/dev/null || true

USER storm

# Standard: API. scanner/telegram-bot überschreiben das Kommando.
EXPOSE 8000
CMD ["python", "-m", "backend.api"]

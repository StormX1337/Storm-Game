"""Nachkontrolle der Alarme

Ergänzt die ``alerts``-Tabelle um das Ergebnis der Nachverfolgung: Urteil,
Closing Line Value und die beiden Vergleichspreise. Bestehende Zeilen bleiben
unangetastet - ``verdict IS NULL`` heißt schlicht "nie nachkontrolliert" und
wird in der Auswertung getrennt ausgewiesen.

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("alerts", sa.Column("verdict", sa.String(length=24), nullable=True))
    op.add_column("alerts", sa.Column("clv_percent", sa.Float(), nullable=True))
    op.add_column("alerts", sa.Column("closing_odds", sa.Float(), nullable=True))
    op.add_column("alerts", sa.Column("closing_fair_odds", sa.Float(), nullable=True))
    op.add_column("alerts", sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_alerts_verdict"), "alerts", ["verdict"], unique=False)
    op.create_index(op.f("ix_alerts_resolved_at"), "alerts", ["resolved_at"], unique=False)
    op.create_index("ix_alerts_verdict_kind", "alerts", ["verdict", "kind"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_alerts_verdict_kind", table_name="alerts")
    op.drop_index(op.f("ix_alerts_resolved_at"), table_name="alerts")
    op.drop_index(op.f("ix_alerts_verdict"), table_name="alerts")
    op.drop_column("alerts", "resolved_at")
    op.drop_column("alerts", "closing_fair_odds")
    op.drop_column("alerts", "closing_odds")
    op.drop_column("alerts", "clv_percent")
    op.drop_column("alerts", "verdict")

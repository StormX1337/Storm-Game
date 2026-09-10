"""Live oder vor dem Anpfiff - als eigene Spalte.

Bisher stand der Zustand des Events nur im ``payload``. Danach filtern hieße
JSON durchsuchen, und ein JSON-Feld bekommt keinen Index - bei einigen
tausend Alarmen pro Woche ist das der Unterschied zwischen einer schnellen
und einer trägen Seite.

Bestandszeilen bekommen ``unknown``. Sie nachträglich auf ``live`` zu setzen
wäre bequem und wäre geraten: welcher Alarm vor dieser Spalte zu einem
laufenden Spiel gehörte, steht nirgends verlässlich. Neue Alarme tragen den
Wert vom ersten Moment an, das Dashboard zeigt ohnehin ein Zeitfenster von
Minuten - der Zustand sortiert sich also von selbst.

Revision ID: 0007
Revises: 0006
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "alerts",
        sa.Column("phase", sa.String(length=12), nullable=False, server_default="unknown"),
    )
    op.create_index("ix_alerts_phase", "alerts", ["phase"])


def downgrade() -> None:
    op.drop_index("ix_alerts_phase", table_name="alerts")
    op.drop_column("alerts", "phase")

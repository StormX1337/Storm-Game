"""Handlungsempfehlung je Alarm

Ergänzt die ``alerts``-Tabelle um das Ergebnis der Empfehlungsrechnung:
Grad, vorgeschlagener Einsatz und der glaubwürdige Vorteil. Letzterer ist
bewusst nicht dasselbe wie ``value_percent`` - er ist der Rest, der nach
Abzug von Unsicherheit und Unplausibilität übrig bleibt, und genau danach
wird sortiert.

Bestehende Zeilen bleiben unangetastet: ``recommendation_grade IS NULL``
heißt "vor Einführung der Empfehlung entstanden" und wird in der Auswertung
nicht als "nicht spielen" gezählt.

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("alerts", sa.Column("recommendation_grade", sa.String(length=16), nullable=True))
    op.add_column("alerts", sa.Column("stake_percent", sa.Float(), nullable=True))
    op.add_column("alerts", sa.Column("credible_edge_percent", sa.Float(), nullable=True))
    op.create_index(
        op.f("ix_alerts_recommendation_grade"), "alerts", ["recommendation_grade"], unique=False
    )
    op.create_index(
        "ix_alerts_grade_detected", "alerts", ["recommendation_grade", "detected_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_alerts_grade_detected", table_name="alerts")
    op.drop_index(op.f("ix_alerts_recommendation_grade"), table_name="alerts")
    op.drop_column("alerts", "credible_edge_percent")
    op.drop_column("alerts", "stake_percent")
    op.drop_column("alerts", "recommendation_grade")

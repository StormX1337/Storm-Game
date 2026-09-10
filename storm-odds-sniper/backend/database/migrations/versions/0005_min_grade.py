"""Mindestgrad je Empfänger

Ergänzt ``user_settings`` um ``min_grade``: ab welchem Empfehlungsgrad ein
Alarm überhaupt nach Telegram geht. Bestehende Zeilen bekommen ``any`` -
also genau das bisherige Verhalten. Niemand soll nach einem Update plötzlich
weniger bekommen als am Tag davor, ohne es umgestellt zu haben.

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column("min_grade", sa.String(length=8), nullable=False, server_default="any"),
    )


def downgrade() -> None:
    op.drop_column("user_settings", "min_grade")

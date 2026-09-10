"""Einheit des Einsatzes je Wette

Ohne hinterlegte Bankroll ist ein Einsatz ein Anteil (0,7 = 0,7 % der
Bankroll), mit Bankroll ein Betrag (7,00). Beides in einer Summe ergäbe eine
Zahl ohne Bedeutung. Die Einheit steht deshalb ab jetzt an jeder Zeile.

Bestandszeilen bekommen ``percent``: das Wett-Tagebuch ist neu, und wer
BANKROLL noch nicht gesetzt hat, hat genau Anteile eingetragen. Wer sie
gesetzt hatte, korrigiert die wenigen Zeilen von Hand - das ist ehrlicher,
als eine Einheit zu raten, die niemand mehr nachprüfen kann.

Revision ID: 0006
Revises: 0005
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "bets",
        sa.Column("stake_unit", sa.String(length=8), nullable=False, server_default="percent"),
    )


def downgrade() -> None:
    op.drop_column("bets", "stake_unit")

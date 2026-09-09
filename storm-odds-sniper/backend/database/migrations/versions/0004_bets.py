"""Wett-Tagebuch

Legt die Tabelle ``bets`` an: was tatsächlich gespielt wurde. Getrennt von
``alerts``, weil ein Alarm eine Beobachtung ist und eine Wette eine
Handlung - und weil die genommene Quote regelmäßig von der gemeldeten
abweicht. Genau diese Differenz will man später sehen können.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "bets",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("alert_fingerprint", sa.String(length=32), nullable=True),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("event_title", sa.String(length=160), nullable=False),
        sa.Column("sport", sa.String(length=16), nullable=False),
        sa.Column("market_key", sa.String(length=96), nullable=False),
        sa.Column("market_label", sa.String(length=128), nullable=False),
        sa.Column("selection_key", sa.String(length=96), nullable=False),
        sa.Column("selection_label", sa.String(length=128), nullable=False),
        sa.Column("bookmaker", sa.String(length=64), nullable=False),
        sa.Column("odds", sa.Float(), nullable=False),
        sa.Column("stake", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("profit", sa.Float(), nullable=True),
        sa.Column("expected_edge_percent", sa.Float(), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=False),
        sa.Column("placed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bets")),
    )
    op.create_index(op.f("ix_bets_user_id"), "bets", ["user_id"], unique=False)
    op.create_index(op.f("ix_bets_alert_fingerprint"), "bets", ["alert_fingerprint"], unique=False)
    op.create_index(op.f("ix_bets_event_id"), "bets", ["event_id"], unique=False)
    op.create_index(op.f("ix_bets_status"), "bets", ["status"], unique=False)
    op.create_index(op.f("ix_bets_placed_at"), "bets", ["placed_at"], unique=False)
    op.create_index("ix_bets_user_status", "bets", ["user_id", "status"], unique=False)
    op.create_index("ix_bets_status_placed", "bets", ["status", "placed_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_bets_status_placed", table_name="bets")
    op.drop_index("ix_bets_user_status", table_name="bets")
    op.drop_index(op.f("ix_bets_placed_at"), table_name="bets")
    op.drop_index(op.f("ix_bets_status"), table_name="bets")
    op.drop_index(op.f("ix_bets_event_id"), table_name="bets")
    op.drop_index(op.f("ix_bets_alert_fingerprint"), table_name="bets")
    op.drop_index(op.f("ix_bets_user_id"), table_name="bets")
    op.drop_table("bets")

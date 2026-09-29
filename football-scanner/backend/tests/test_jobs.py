from datetime import UTC, datetime, timedelta

from app.models import JobRun, SystemLog
from app.services.jobs import JOBS, due_jobs, run_job


def test_jobs_without_keys_are_skipped_not_failed(db):
    status, message = run_job("fixtures")
    assert status == "skipped" and "not configured" in message
    run = db.get(JobRun, "fixtures")
    db.refresh(run)
    assert run.last_status == "skipped"
    assert db.query(SystemLog).filter(SystemLog.level == "ERROR").count() == 0


def test_analysis_and_settlement_run_without_providers(db):
    assert run_job("analysis")[0] == "ok"
    assert run_job("settlement")[0] == "ok"


def test_due_jobs_respects_intervals_and_requests(db):
    assert due_jobs(db) == list(JOBS)
    now = datetime.now(UTC)
    for name in JOBS:
        db.add(JobRun(name=name, last_started_at=now))
    db.commit()
    assert due_jobs(db, now + timedelta(minutes=1)) == []
    assert due_jobs(db, now + timedelta(minutes=3)) == ["live"]
    db.get(JobRun, "odds").requested_at = now
    db.commit()
    assert due_jobs(db, now + timedelta(minutes=1)) == ["odds"]

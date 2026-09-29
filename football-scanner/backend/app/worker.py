"""Background worker: ``python -m app.worker``.

Every tick it runs whichever jobs are due (or were requested from the admin
panel). Jobs take a Redis lock, so running two workers is safe.
"""

import logging
import signal
import time

from app.db import session_factory
from app.services.jobs import due_jobs, run_job

log = logging.getLogger("worker")
_stop = False


def _handle(signum, _frame):
    global _stop
    log.info("signal %s received, stopping after this tick", signum)
    _stop = True


def main(tick_seconds: int = 30) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    log.info("worker started")
    while not _stop:
        try:
            with session_factory()() as db:
                names = due_jobs(db)
            for name in names:
                if _stop:
                    break
                status, message = run_job(name)
                log.info("job %s: %s — %s", name, status, message)
        except Exception:
            log.exception("worker tick failed")
        for _ in range(tick_seconds):
            if _stop:
                break
            time.sleep(1)
    log.info("worker stopped")


if __name__ == "__main__":
    main()

"""API-Start ohne externen Prozessmanager::

python -m backend.api
"""

from __future__ import annotations

import uvicorn

from backend.core.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "backend.api.app:app",
        host=settings.api_host,
        port=settings.api_port,
        log_config=None,
        access_log=False,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()

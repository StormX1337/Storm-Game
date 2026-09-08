"""Zugangsschutz fürs Dashboard.

Getestet wird das Skript, das der nginx-Container beim Start ausführt. Die
nginx-Integration selbst lässt sich nur mit laufendem nginx prüfen; die
Logik, die entscheidet ob und wie geschützt wird, ist hier abgedeckt.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO / "docker" / "nginx" / "10-dashboard-auth.sh"
SETTER = REPO / "scripts" / "set-dashboard-password.sh"


def run_entrypoint(tmp_path: Path, auth: str | None) -> subprocess.CompletedProcess:
    """Das Container-Skript mit umgebogenen Pfaden ausführen."""
    script = ENTRYPOINT.read_text()
    script = script.replace(
        "AUTH_CONF=/etc/nginx/dashboard-auth.conf", f"AUTH_CONF={tmp_path}/dashboard-auth.conf"
    )
    script = script.replace("HTPASSWD=/etc/nginx/.htpasswd", f"HTPASSWD={tmp_path}/.htpasswd")
    target = tmp_path / "entrypoint.sh"
    target.write_text(script)

    env = {"PATH": "/usr/bin:/bin"}
    if auth is not None:
        env["DASHBOARD_AUTH"] = auth
    return subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
        ["/bin/sh", str(target)], capture_output=True, text=True, env=env, check=False
    )


class TestEntrypoint:
    def test_without_credentials_everything_stays_open(self, tmp_path):
        """Bestehende Installationen dürfen sich nicht plötzlich aussperren."""
        result = run_entrypoint(tmp_path, None)
        assert result.returncode == 0
        assert (tmp_path / "dashboard-auth.conf").read_text().strip() == "auth_basic off;"
        assert not (tmp_path / ".htpasswd").exists()
        assert "OFFEN" in result.stdout

    def test_credentials_enable_basic_auth(self, tmp_path):
        result = run_entrypoint(tmp_path, "admin:$apr1$abc$def")
        assert result.returncode == 0
        conf = (tmp_path / "dashboard-auth.conf").read_text()
        assert 'auth_basic "Storm Odds Sniper";' in conf
        assert "auth_basic_user_file" in conf
        assert (tmp_path / ".htpasswd").read_text().strip() == "admin:$apr1$abc$def"
        assert "admin" in result.stdout

    def test_the_password_file_is_readable_by_the_nginx_worker(self, tmp_path):
        """Mit 600 antwortet nginx auf jede korrekte Anmeldung mit 500:
        der Worker läuft unprivilegiert und darf die Datei nicht lesen."""
        run_entrypoint(tmp_path, "admin:$apr1$abc$def")
        mode = (tmp_path / ".htpasswd").stat().st_mode & 0o777
        assert mode & 0o044, f"für andere nicht lesbar: {mode:o}"

    def test_malformed_input_fails_loudly(self, tmp_path):
        result = run_entrypoint(tmp_path, "ohne_doppelpunkt")
        assert result.returncode != 0
        assert "benutzer:hash" in result.stderr
        assert not (tmp_path / ".htpasswd").exists()

    def test_the_hash_is_written_verbatim(self, tmp_path):
        """apr1-Hashes enthalten $-Zeichen - die dürfen nicht expandiert werden."""
        raw = "admin:$apr1$Xy1Z$abcdefghijklmnopqrstuv"
        run_entrypoint(tmp_path, raw)
        assert (tmp_path / ".htpasswd").read_text().strip() == raw


@pytest.mark.skipif(not shutil.which("openssl"), reason="openssl nicht verfügbar")
class TestPasswordSetter:
    def _run(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        # Die *Kopie* aufrufen: das Skript leitet sein Arbeitsverzeichnis aus
        # dem eigenen Pfad ab, nicht aus cwd. Mit dem Original würde es die
        # echte .env des Projekts verändern.
        script = root / "scripts" / SETTER.name
        return subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(script), *args], cwd=root, capture_output=True, text=True, check=False
        )

    def _prepare(self, tmp_path: Path) -> Path:
        """Minimales Projektabbild, damit das Skript relativ arbeiten kann."""
        (tmp_path / "scripts").mkdir()
        shutil.copy(SETTER, tmp_path / "scripts" / SETTER.name)
        (tmp_path / ".env").write_text("PROVIDERS=mock\nPOSTGRES_PASSWORD=geheim\n")
        return tmp_path

    def test_it_writes_a_hash_not_the_password(self, tmp_path):
        root = self._prepare(tmp_path)
        result = self._run(root, "admin", "supergeheim")
        assert result.returncode == 0, result.stderr
        env = (root / ".env").read_text()
        assert "DASHBOARD_AUTH=admin:" in env
        assert "supergeheim" not in env, "das Klartextpasswort darf nirgends landen"

    def test_other_settings_survive(self, tmp_path):
        root = self._prepare(tmp_path)
        self._run(root, "admin", "geheim")
        env = (root / ".env").read_text()
        assert "POSTGRES_PASSWORD=geheim" in env
        assert "PROVIDERS=mock" in env

    def test_running_twice_replaces_instead_of_appending(self, tmp_path):
        root = self._prepare(tmp_path)
        self._run(root, "admin", "erstes")
        self._run(root, "admin", "zweites")
        env = (root / ".env").read_text()
        assert env.count("DASHBOARD_AUTH=") == 1

    def test_a_colon_in_the_username_is_rejected(self, tmp_path):
        root = self._prepare(tmp_path)
        result = self._run(root, "ad:min", "geheim")
        assert result.returncode != 0
        assert "Doppelpunkt" in result.stderr

    def test_an_empty_password_is_rejected(self, tmp_path):
        root = self._prepare(tmp_path)
        result = self._run(root, "admin", "")
        assert result.returncode != 0

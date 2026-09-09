"""Zugangsschutz fürs Dashboard.

Getestet wird das Skript, das der nginx-Container beim Start ausführt. Die
nginx-Integration selbst lässt sich nur mit laufendem nginx prüfen; die
Logik, die entscheidet ob und wie geschützt wird, ist hier abgedeckt.
"""

from __future__ import annotations

import os
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


class TestDollarZeichen:
    """Docker Compose ersetzt in der .env jedes ``$NAME`` durch eine Variable.
    Ein apr1-Hash besteht fast nur aus solchen Stellen und verschwand dadurch
    spurlos - übrig blieb ``benutzer:``, und jede korrekte Anmeldung endete
    mit 401, ohne erkennbaren Grund."""

    HASH = "$apr1$frYtsx1F$gU557er1Q0RlYieQT4Y461"

    def test_doubled_dollars_are_restored(self, tmp_path):
        """So kommt der Wert an, wenn er die Interpolation umgangen hat."""
        doubled = self.HASH.replace("$", "$$")
        result = run_entrypoint(tmp_path, f"admin:{doubled}")
        assert result.returncode == 0
        assert (tmp_path / ".htpasswd").read_text().strip() == f"admin:{self.HASH}"

    def test_single_dollars_pass_through_unchanged(self, tmp_path):
        """Und so, wenn Compose sie korrekt aufgelöst hat."""
        result = run_entrypoint(tmp_path, f"admin:{self.HASH}")
        assert result.returncode == 0
        assert (tmp_path / ".htpasswd").read_text().strip() == f"admin:{self.HASH}"

    def test_a_lost_hash_stops_the_container(self, tmp_path):
        """Genau der Wert, den Compose ohne Verdopplung erzeugt hat."""
        result = run_entrypoint(tmp_path, "admin:")
        assert result.returncode != 0
        assert "Hash fehlt" in result.stderr
        assert "verdoppelt" in result.stderr
        assert not (tmp_path / ".htpasswd").exists()

    def test_something_that_is_not_a_hash_stops_the_container(self, tmp_path):
        """Ein Klartextpasswort in der .env würde nginx nie akzeptieren."""
        result = run_entrypoint(tmp_path, "admin:klartext")
        assert result.returncode != 0
        assert "sieht nicht wie ein Hash aus" in result.stderr

    def test_the_sha_fallback_is_accepted(self, tmp_path):
        """Das {SHA}-Format enthält kein $ und braucht keine Verdopplung."""
        result = run_entrypoint(tmp_path, "admin:{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")
        assert result.returncode == 0
        assert "{SHA}" in (tmp_path / ".htpasswd").read_text()

    def test_an_empty_username_is_rejected(self, tmp_path):
        result = run_entrypoint(tmp_path, f":{self.HASH}")
        assert result.returncode != 0
        assert "Benutzername" in result.stderr

    def test_failing_closed_leaves_no_password_file(self, tmp_path):
        """Kein halb geschriebener Zustand: lieber gar nicht starten."""
        run_entrypoint(tmp_path, "admin:")
        assert not (tmp_path / ".htpasswd").exists()
        assert not (tmp_path / "dashboard-auth.conf").exists()


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
        (tmp_path / ".env").write_text("PROVIDERS=sportsgameodds\nPOSTGRES_PASSWORD=geheim\n")
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
        assert "PROVIDERS=sportsgameodds" in env

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

    def test_dollars_are_doubled_for_compose(self, tmp_path):
        """Ohne Verdopplung frisst die Compose-Interpolation den halben Hash."""
        root = self._prepare(tmp_path)
        assert self._run(root, "admin", "geheim").returncode == 0
        line = next(
            row
            for row in (root / ".env").read_text().splitlines()
            if row.startswith("DASHBOARD_AUTH=")
        )
        assert "$$apr1$$" in line, line
        assert "$apr1$" not in line.replace("$$", ""), "einfaches $ übrig geblieben"

    def test_the_written_value_survives_unescaping(self, tmp_path):
        """Was der Container zurückverwandelt, muss der echte Hash sein."""
        root = self._prepare(tmp_path)
        self._run(root, "admin", "geheim")
        line = next(
            row
            for row in (root / ".env").read_text().splitlines()
            if row.startswith("DASHBOARD_AUTH=")
        )
        value = line.split("=", 1)[1].replace("$$", "$")
        user, _, hashed = value.partition(":")
        assert user == "admin"
        assert hashed.startswith("$apr1$")
        assert hashed.count("$") == 3, hashed

    def test_the_end_to_end_round_trip_through_the_entrypoint(self, tmp_path):
        """Skript schreibt -> Compose löst auf -> Container schreibt .htpasswd.

        Die Compose-Stufe wird hier nachgebildet (``$$`` wird zu ``$``); dass
        Compose sich so verhält, prüft ``TestComposeInterpolation``.
        """
        root = self._prepare(tmp_path)
        self._run(root, "admin", "geheim")
        line = next(
            row
            for row in (root / ".env").read_text().splitlines()
            if row.startswith("DASHBOARD_AUTH=")
        )
        interpolated = line.split("=", 1)[1].replace("$$", "$")

        target = tmp_path / "nginx"
        target.mkdir()
        result = run_entrypoint(target, interpolated)
        assert result.returncode == 0, result.stderr
        written = (target / ".htpasswd").read_text().strip()
        assert written == interpolated
        assert written.startswith("admin:$apr1$")


@pytest.mark.skipif(
    not shutil.which("docker") or not shutil.which("openssl"),
    reason="docker oder openssl nicht verfügbar",
)
class TestComposeInterpolation:
    """Die Annahme, auf der alles steht: Compose macht aus ``$$`` ein ``$``.

    Ohne diesen Test wäre das eine Behauptung - und genau eine solche
    ungeprüfte Annahme war die Ursache des Fehlers.
    """

    def _config(self, root: Path) -> subprocess.CompletedProcess:
        docker = shutil.which("docker") or "docker"
        return subprocess.run(  # noqa: S603 - fester Aufruf
            [docker, "compose", "config"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )

    def _prepare(self, tmp_path: Path, auth_line: str) -> Path:
        shutil.copy(REPO / "docker-compose.yml", tmp_path / "docker-compose.yml")
        (tmp_path / ".env").write_text("POSTGRES_PASSWORD=x\n" + auth_line + "\n")
        return tmp_path

    def test_unescaped_dollars_are_eaten(self, tmp_path):
        """Der ursprüngliche Fehler, als Test festgehalten."""
        root = self._prepare(tmp_path, "DASHBOARD_AUTH=admin:$apr1$frYtsx1F$gU557er1Q0Rl")
        result = self._config(root)
        if result.returncode != 0:
            pytest.skip(f"docker compose nicht nutzbar: {result.stderr[:120]}")
        assert "variable is not set" in result.stderr
        assert "apr1" not in result.stdout

    def test_escaped_dollars_survive(self, tmp_path):
        root = self._prepare(tmp_path, "DASHBOARD_AUTH=admin:$$apr1$$frYtsx1F$$gU557er1Q0Rl")
        result = self._config(root)
        if result.returncode != 0:
            pytest.skip(f"docker compose nicht nutzbar: {result.stderr[:120]}")
        assert "variable is not set" not in result.stderr
        # config gibt eine Compose-Datei aus, dort steht ein literales $ als $$.
        line = next(row for row in result.stdout.splitlines() if "DASHBOARD_AUTH:" in row)
        assert "apr1" in line

    def test_the_setter_output_produces_no_warnings(self, tmp_path):
        """Der eigentliche Beweis: Skript schreiben lassen, Compose fragen."""
        (tmp_path / "scripts").mkdir()
        shutil.copy(SETTER, tmp_path / "scripts" / SETTER.name)
        shutil.copy(REPO / "docker-compose.yml", tmp_path / "docker-compose.yml")
        (tmp_path / ".env").write_text("POSTGRES_PASSWORD=x\n")
        written = subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(tmp_path / "scripts" / SETTER.name), "admin", "geheim"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
        assert written.returncode == 0, written.stderr
        result = self._config(tmp_path)
        if result.returncode != 0:
            pytest.skip(f"docker compose nicht nutzbar: {result.stderr[:120]}")
        assert "variable is not set" not in result.stderr


class TestDashboardRobustheit:
    """Das Dashboard darf nicht an einem einzelnen Endpunkt hängen.

    Beobachtet: nach einem ``git pull`` ohne Neubau kannte die alte API
    ``/alerts/scorecard`` nicht. Das eine 404 riss über ``Promise.all`` alle
    anderen Abfragen mit - jede Kachel blieb auf "Lade...", obwohl ihre Daten
    längst da waren.
    """

    APP = REPO / "frontend" / "src" / "app.js"
    CSS = REPO / "frontend" / "src" / "styles.css"
    HTML = REPO / "frontend" / "src" / "index.html"

    def test_requests_are_settled_not_all_or_nothing(self):
        source = self.APP.read_text()
        assert "Promise.allSettled" in source
        assert "Promise.all(" not in source, "ein Ausfall würde wieder alles mitreißen"

    def test_a_missing_endpoint_is_named_in_the_page(self):
        source = self.APP.read_text()
        assert "reportVersionMismatch" in source
        assert "error.status === 404" in source
        html = self.HTML.read_text()
        assert 'id="stale-api"' in html
        assert "--build" in html, "der Hinweis muss den Befehl nennen, der es behebt"

    def test_hidden_actually_hides(self):
        """``.banner`` setzt display:flex und schlägt damit das UA-[hidden]."""
        css = self.CSS.read_text()
        assert "[hidden]" in css and "display: none !important" in css

    def test_every_panel_renders_independently(self):
        """Jeder Renderaufruf hängt an seiner eigenen Antwort."""
        source = self.APP.read_text()
        for guard in (
            "if (stats) {",
            "if (events) {",
            "if (providers) {",
            "if (scorecard) {",
            "if (alerts) {",
        ):
            assert guard in source, guard


class TestAbschalten:
    """Der Zugangsschutz muss sich genauso einfach wieder entfernen lassen."""

    def _prepare(self, tmp_path: Path) -> Path:
        (tmp_path / "scripts").mkdir()
        shutil.copy(SETTER, tmp_path / "scripts" / SETTER.name)
        (tmp_path / ".env").write_text("PROVIDERS=sportsgameodds\nPOSTGRES_PASSWORD=geheim\n")
        return tmp_path

    def _run(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(root / "scripts" / SETTER.name), *args],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )

    @pytest.mark.skipif(not shutil.which("openssl"), reason="openssl nicht verfügbar")
    def test_off_clears_the_value(self, tmp_path):
        root = self._prepare(tmp_path)
        self._run(root, "admin", "geheim")
        result = self._run(root, "--off")
        assert result.returncode == 0
        env = (root / ".env").read_text()
        assert "DASHBOARD_AUTH=\n" in env or env.rstrip().endswith("DASHBOARD_AUTH=")
        assert "apr1" not in env
        assert "ABGESCHALTET" in result.stdout

    def test_off_keeps_other_settings(self, tmp_path):
        root = self._prepare(tmp_path)
        self._run(root, "--off")
        env = (root / ".env").read_text()
        assert "POSTGRES_PASSWORD=geheim" in env
        assert "PROVIDERS=sportsgameodds" in env

    def test_off_says_the_dashboard_is_open_again(self, tmp_path):
        root = self._prepare(tmp_path)
        result = self._run(root, "--off")
        assert "erreichbar" in result.stdout

    def test_off_leaves_exactly_one_line(self, tmp_path):
        root = self._prepare(tmp_path)
        self._run(root, "--off")
        self._run(root, "--off")
        assert (root / ".env").read_text().count("DASHBOARD_AUTH=") == 1


class TestWrapperNutztHostCode:
    """``setup-provider.sh`` muss den aktuellen Code ausführen, nicht den aus
    dem Image.

    Beobachtet: nach ``git pull`` ohne ``--build`` brach die Einrichtungshilfe
    mit ``invalid choice: 'sportsgameodds'`` ab - der neue Provider lag auf dem
    Host, der Container lief mit dem alten Image.
    """

    WRAPPER = REPO / "scripts" / "setup-provider.sh"

    def _run(self, tmp_path: Path, *args: str) -> tuple[subprocess.CompletedProcess, str]:
        (tmp_path / "scripts").mkdir()
        (tmp_path / "backend").mkdir()
        shutil.copy(self.WRAPPER, tmp_path / "scripts" / self.WRAPPER.name)
        shutil.copy(REPO / "docker-compose.yml", tmp_path / "docker-compose.yml")
        (tmp_path / ".env").write_text("PROVIDERS=sportsgameodds\n")

        fake = tmp_path / "fake"
        fake.mkdir()
        calls = tmp_path / "calls.log"
        (fake / "docker").write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "info" ]; then exit 0; fi\n'
            f'printf "%s\\n" "$*" >> "{calls}"\n'
            "exit 0\n"
        )
        (fake / "docker").chmod(0o755)

        env = dict(os.environ, PATH=f"{fake}:{os.environ['PATH']}")
        result = subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(tmp_path / "scripts" / self.WRAPPER.name), *args],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        return result, calls.read_text() if calls.exists() else ""

    def test_host_code_is_mounted_over_the_image(self, tmp_path):
        _, call = self._run(tmp_path, "sportsgameodds", "--key", "x")
        assert "/app/backend:ro" in call, "backend/ wird nicht hineingereicht"
        assert "/app/scripts:ro" in call, "scripts/ wird nicht hineingereicht"

    def test_the_env_stays_writable(self, tmp_path):
        """--write muss auf dem Host wirken - die .env darf nicht read-only sein."""
        _, call = self._run(tmp_path, "the_odds_api", "--key", "x", "--write")
        assert "/app/.env" in call
        assert "/app/.env:ro" not in call

    def test_arguments_are_passed_through(self, tmp_path):
        _, call = self._run(tmp_path, "sportsgameodds", "--key", "GEHEIM", "--live")
        assert "sportsgameodds" in call
        assert "--live" in call
        assert "GEHEIM" in call

    def test_bytecode_is_not_written_into_the_readonly_mount(self, tmp_path):
        _, call = self._run(tmp_path, "the_odds_api", "--key", "x")
        assert "PYTHONDONTWRITEBYTECODE=1" in call


class TestBuildHinweise:
    """Nach einem git pull ist ``--build`` die Regel, nicht die Ausnahme.

    Ein Hinweis ohne ``--build`` führt zu genau der Konstellation, die schon
    zweimal Zeit gekostet hat: Host neu, Image alt.
    """

    @pytest.mark.parametrize(
        "name",
        ["setup_provider.py", "set-dashboard-password.sh", "setup-provider.sh"],
    )
    def test_no_hint_forgets_the_build_flag(self, name):
        text = (REPO / "scripts" / name).read_text()
        for line in text.splitlines():
            if "docker compose up -d" in line and "--build" not in line:
                pytest.fail(f"{name}: Hinweis ohne --build: {line.strip()}")

    def test_the_readme_says_build_is_mandatory(self):
        readme = (REPO / "README.md").read_text()
        assert "`--build` ist Pflicht" in readme


class TestDiagnose:
    """``diagnose.sh`` sammelt den Zustand ein - und darf dabei nichts
    Geheimes ausgeben. Der Bericht ist zum Verschicken gedacht."""

    SCRIPT = REPO / "scripts" / "diagnose.sh"

    def _run(self, tmp_path: Path, env_text: str, docker_ok: bool = False):
        (tmp_path / "scripts").mkdir(exist_ok=True)
        shutil.copy(self.SCRIPT, tmp_path / "scripts" / self.SCRIPT.name)
        if env_text is not None:
            (tmp_path / ".env").write_text(env_text)
        fake = tmp_path / "fake"
        fake.mkdir(exist_ok=True)
        (fake / "docker").write_text("#!/bin/sh\n" + ("exit 0\n" if docker_ok else "exit 1\n"))
        (fake / "docker").chmod(0o755)
        env = dict(os.environ, PATH=f"{fake}:{os.environ['PATH']}")
        return subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(tmp_path / "scripts" / self.SCRIPT.name)],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    SECRETS = (
        "PROVIDERS=sportsgameodds\n"
        "SGO_API_KEY=750e0b8889875848739ad4b8a6f02d8b\n"
        "POSTGRES_PASSWORD=supergeheim123\n"
        "TELEGRAM_BOT_TOKEN=123456:AAaaBBbbCCcc\n"
        "DASHBOARD_AUTH=admin:$apr1$xy$zzz\n"
        "DATABASE_URL=postgresql://storm:pw@postgres/storm\n"
        "MIN_BOOKMAKERS=3\n"
    )

    def test_no_secret_value_is_printed(self, tmp_path):
        out = self._run(tmp_path, self.SECRETS).stdout
        for secret in (
            "750e0b8889875848739ad4b8a6f02d8b",
            "supergeheim123",
            "AAaaBBbbCCcc",
            "apr1",
            "pw@postgres",
        ):
            assert secret not in out, f"Geheimnis im Bericht: {secret}"

    def test_the_keys_are_still_visible(self, tmp_path):
        """Ohne die Namen wäre der Bericht wertlos."""
        out = self._run(tmp_path, self.SECRETS).stdout
        assert "SGO_API_KEY=<32 Zeichen>" in out
        assert "POSTGRES_PASSWORD=" in out

    def test_harmless_values_stay_readable(self, tmp_path):
        out = self._run(tmp_path, self.SECRETS).stdout
        assert "PROVIDERS=sportsgameodds" in out
        assert "MIN_BOOKMAKERS=3" in out

    def test_a_missing_env_is_named_as_the_cause(self, tmp_path):
        out = self._run(tmp_path, None).stdout
        assert "KEINE .env" in out

    def test_a_dead_docker_daemon_is_named(self, tmp_path):
        out = self._run(tmp_path, self.SECRETS).stdout
        assert "Docker-Daemon nicht erreichbar" in out

    def test_it_never_fails(self, tmp_path):
        """Ein Diagnoseskript, das selbst abbricht, hilft niemandem."""
        assert self._run(tmp_path, self.SECRETS).returncode == 0
        assert self._run(tmp_path, None).returncode == 0


class TestNginxNamensaufloesung:
    """nginx muss den API-Namen zur Laufzeit auflösen.

    Beobachtet auf dem Server: nginx lief 18 Stunden, der api-Container wurde
    neu erstellt und bekam eine neue IP. Der ``upstream``-Block hatte den
    Namen einmal beim Start aufgelöst - jede Anfrage endete danach in 502
    "Connection refused", obwohl die API einwandfrei antwortete.
    """

    CONF = REPO / "docker" / "nginx" / "default.conf"
    ENTRY = REPO / "docker" / "nginx" / "05-resolver.sh"

    def test_no_static_upstream_block_remains(self):
        text = self.CONF.read_text()
        assert "upstream storm_api" not in text, "der Block cacht die IP wieder"

    def test_every_proxy_pass_uses_a_variable(self):
        """Nur mit Variable löst nginx bei jeder Anfrage neu auf."""
        for line in self.CONF.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("proxy_pass "):
                assert "$" in stripped, f"ohne Variable: {stripped}"

    def test_a_resolver_is_included(self):
        assert "include /etc/nginx/resolver.conf;" in self.CONF.read_text()

    def test_the_api_prefix_is_still_stripped(self):
        """/api/health muss weiterhin als /health ankommen."""
        text = self.CONF.read_text()
        assert "rewrite ^/api/(.*)$ /$1 break;" in text

    def test_the_entrypoint_writes_a_resolver(self, tmp_path):
        script = tmp_path / "resolver.sh"
        conf = tmp_path / "resolver.conf"
        resolv = tmp_path / "resolv.conf"
        resolv.write_text("nameserver 127.0.0.11\nnameserver fe80::1\n")
        script.write_text(
            self.ENTRY.read_text()
            .replace("CONF=/etc/nginx/resolver.conf", f"CONF={conf}")
            .replace("/etc/resolv.conf", str(resolv))
        )
        result = subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(script)], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0, result.stderr
        written = conf.read_text()
        assert "resolver 127.0.0.11" in written
        assert "valid=" in written
        assert "fe80::1" not in written, "IPv6 müsste geklammert werden"

    def test_it_falls_back_when_resolv_conf_is_unusable(self, tmp_path):
        """Ohne resolver startet nginx nicht - dann lieber Dockers Standard."""
        conf = tmp_path / "resolver.conf"
        script = tmp_path / "resolver.sh"
        script.write_text(
            self.ENTRY.read_text()
            .replace("CONF=/etc/nginx/resolver.conf", f"CONF={conf}")
            .replace("/etc/resolv.conf", str(tmp_path / "gibtesnicht"))
        )
        result = subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(script)], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0
        assert "127.0.0.11" in conf.read_text()

    def test_compose_mounts_the_entrypoint(self):
        compose = (REPO / "docker-compose.yml").read_text()
        assert "05-resolver.sh:/docker-entrypoint.d/05-resolver.sh" in compose


class TestDoppelteSchluessel:
    """Doppelte Schlüssel in der .env sind eine Falle: es gilt der letzte."""

    def _run(self, tmp_path: Path, env_text: str) -> str:
        (tmp_path / "scripts").mkdir(exist_ok=True)
        shutil.copy(REPO / "scripts" / "diagnose.sh", tmp_path / "scripts" / "diagnose.sh")
        (tmp_path / ".env").write_text(env_text)
        fake = tmp_path / "fake"
        fake.mkdir(exist_ok=True)
        (fake / "docker").write_text("#!/bin/sh\nexit 1\n")
        (fake / "docker").chmod(0o755)
        env = dict(os.environ, PATH=f"{fake}:{os.environ['PATH']}")
        return subprocess.run(  # noqa: S603 - festes Skript aus dem Repo
            ["/bin/sh", str(tmp_path / "scripts" / "diagnose.sh")],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        ).stdout

    def test_duplicates_are_named(self, tmp_path):
        out = self._run(
            tmp_path,
            "PROVIDERS=the_odds_api\nMIN_BOOKMAKERS=3\nPROVIDERS=sportsgameodds\n",
        )
        assert "MEHRFACH" in out
        assert "PROVIDERS" in out

    def test_a_clean_env_stays_quiet(self, tmp_path):
        out = self._run(tmp_path, "PROVIDERS=sportsgameodds\nMIN_BOOKMAKERS=3\n")
        assert "MEHRFACH" not in out

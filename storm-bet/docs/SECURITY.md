# Sicherheit & Compliance

## Authentifizierung und Sitzungen

- Passwörter: Argon2id (19 MiB, t=2, p=1), automatisches Rehashing bei stärkeren Parametern
- Sitzungen: 256-Bit-Zufallstoken im Cookie `sb_session` (HttpOnly, SameSite=Lax, Secure bei HTTPS); in der
  Datenbank nur der SHA-256-Hash. Absolute Laufzeit + Leerlauf-Timeout (Staff: 30 Minuten)
- Widerruf: Logout, „überall abmelden“, Passwortänderung/-reset, Sperrung und Rollenwechsel beenden Sitzungen
- Brute-Force: Rate-Limit pro IP, Sperre pro Konto nach 5 Fehlversuchen (15 Minuten), gleiche Antwort und
  gleicher Rechenaufwand für unbekannte Konten
- Passwort-Reset und E-Mail-Bestätigung: einmalige, gehashte Tokens mit Ablaufzeit; ein neuer Link entwertet
  ältere; die Anfrage verrät nicht, ob ein Konto existiert

## Anfragen

- CSRF: Origin-Prüfung + Double-Submit-Token, per HMAC an die Sitzung gebunden, Rotation beim Login
- Eingaben: jede Route validiert mit Zod; Fehler als `VALIDATION_ERROR` mit Feldmeldungen
- SQL: ausschließlich Prisma-Abfragen bzw. parametrisierte `$queryRaw`-Templates
- XSS: React-Escaping, kein `dangerouslySetInnerHTML`, CSP mit Nonce und `strict-dynamic`
- Header: CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP, HSTS bei HTTPS
- Rate-Limits (Redis, Sliding Window) pro IP und pro Nutzer, u. a. für Login, Registrierung, Wetten, Admin
- Fehler: einheitliches Format mit Request-ID, niemals Stacktraces oder interne Meldungen

## Admin

- RBAC mit feingranularen Berechtigungen (`packages/types/src/rbac.ts`), auf jeder Route serverseitig geprüft
- Optionale IP-Allowlist, eigenes Rate-Limit, `Cache-Control: no-store`
- Rollenänderungen verlangen die Passwortbestätigung des handelnden Admins; eigene Rolle und letzter Admin
  sind geschützt
- Jede Mutation verlangt eine Begründung und schreibt im selben Datenbank-Commit einen Audit-Eintrag (Akteur,
  Aktion, Ziel, Zeitpunkt, IP – abschaltbar über `AUDIT_LOG_IP` –, Vorher/Nachher)
- Das Audit-Log ist append-only (Trigger blockiert UPDATE, DELETE und TRUNCATE – auch für Admins)
- Abgerechnete Wetten sind in der Datenbank unveränderlich; Korrekturen offener Wetten nur als Storno mit
  Erstattung und Audit-Trail

## Responsible Gaming / Compliance

| Baustein     | Stand                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- |
| Demo-Hinweis | auf jeder Seite, jedes Event als „Demo“ markiert                                              |
| Echtgeld     | technisch gesperrt (`REAL_MONEY_ENABLED` verhindert den Start), `DisabledPaymentGateway`      |
| Limits       | Einsatz pro Wette/24 h/7 Tage/30 Tage; Senkung sofort, Erhöhung nach 24 h Bedenkzeit          |
| Selbstsperre | 24 h bis unbefristet, nicht vorzeitig aufhebbar, blockiert Wetten serverseitig                |
| Alter        | Bestätigung bei Registrierung; `isOfAge()` und `dateOfBirth` für künftige Prüfung vorbereitet |
| KYC          | `KycProvider`-Schnittstelle, Demo-Implementierung meldet „nicht erforderlich“                 |
| Jurisdiktion | `JurisdictionPolicy` mit Länder-Sperrliste; Echtgeld immer `false`                            |

Vor einem Echtgeldbetrieb zwingend: Glücksspiellizenz, KYC/AML-Anbieter, Geolokalisierung, Anbindung an
Sperrdateien, Einzahlungs-/Verlustlimits, Reality-Checks, Datenschutz-Folgenabschätzung, Penetrationstest.

## Secrets

Keine Secrets im Repository. `.env` ist ausgeschlossen, `.env.example` enthält nur Platzhalter. Docker-Builds
bekommen optionale CA-Zertifikate als BuildKit-Secret, nichts davon landet im Image.

/* Storm Odds Sniper - Dashboard-Logik.
 *
 * Bewusst ohne Framework: eine Seite, ein WebSocket, direkte DOM-Updates.
 * Der WebSocket liefert Alarme/Events live; REST füllt beim Laden auf und
 * dient als Rückfallebene, falls der Socket abreißt.
 */
(() => {
  "use strict";

  const API = window.STORM_API_BASE || "/api";
  const MAX_ALERTS = 150;
  const MAX_MOVES = 40;
  // Unter so vielen ausgewerteten Alarmen wird kein Durchschnitt angezeigt -
  // ein Mittelwert aus zwei Werten ist ein Zufallsergebnis.
  const MIN_SCORED = 10;

  const state = {
    alerts: [],
    moves: [],
    events: new Map(),
    bookmakers: new Map(),
    filter: "all",
    socket: null,
    reconnectDelay: 1000,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const fmtTime = (value) => {
    const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    return date.toLocaleTimeString("de-DE", { hour12: false }) +
      "." + String(date.getMilliseconds()).padStart(3, "0");
  };
  const fmtOdds = (value) => (typeof value === "number" ? value.toFixed(2) : "–");
  const fmtPct = (value) =>
    typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "–";

  // Quellen, deren Daten erfunden sind. Zeilen daraus werden markiert, damit
  // echte und simulierte Einträge nicht nebeneinander gleich aussehen.
  const SIMULATED = new Set(["mock"]);
  const isSim = (provider) => SIMULATED.has(String(provider || "").toLowerCase());

  const STATUS_TAG = { LIVE: "live", PRE_MATCH: "pre", SUSPENDED: "susp", FINISHED: "fin" };
  const SPORT_ICON = { football: "⚽", tennis: "🎾" };
  const KIND_LABEL = { fixed_error: "🎯 Fixed", value: "💎 Value", odds_move: "📈 Move" };

  /* Nachkontrolle: was aus einem Alarm geworden ist. Ohne diese Spalte bleibt
     jede Meldung eine unbelegte Behauptung. */
  const VERDICT = {
    corrected: { icon: "✅", short: "korrigiert", tag: "good",
      text: "Der Buchmacher hat den Preis selbst gesenkt - der Fehlpreis war echt." },
    vanished: { icon: "🚫", short: "gezogen", tag: "good",
      text: "Die Quote wurde zurückgezogen oder gesperrt." },
    market_followed: { icon: "↗️", short: "Markt folgte", tag: "warn",
      text: "Der Markt ist zum gemeldeten Preis gestiegen - der Buchmacher war nur schneller." },
    held: { icon: "⏸", short: "unverändert", tag: "",
      text: "Der Preis steht noch, der Abstand zum Markt besteht weiter." },
    reverted: { icon: "↩️", short: "zurück", tag: "warn",
      text: "Die Bewegung ist wieder zurückgelaufen." },
    superseded: { icon: "🔄", short: "überholt", tag: "",
      text: "Der Spielstand hat sich geändert - ein Preisvergleich wäre sinnlos." },
    unresolved: { icon: "❔", short: "offen", tag: "",
      text: "Keine Folgedaten - kein Urteil möglich." },
    // Kein Urteil, sondern dessen Abwesenheit - taucht nur in der Bilanz auf.
    pending: { icon: "⏳", short: "offen", tag: "",
      text: "Die Nachkontrolle steht noch aus." },
  };

  /* ------------------------------------------------------------ Rendering */

  function alertPasses(alert) {
    const f = state.filter;
    if (f === "all") return true;
    if (f === "football" || f === "tennis") return alert.sport === f;
    return alert.kind === f;
  }

  function renderAlerts() {
    const body = $("alerts-body");
    const rows = state.alerts.filter(alertPasses).slice(0, MAX_ALERTS);
    if (!rows.length) {
      body.innerHTML = '<tr class="empty"><td colspan="11">Keine Alarme für diesen Filter.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map((a, index) => {
        const valueClass = a.value_percent >= 0 ? "pos" : "neg";
        const tag = STATUS_TAG[a.status] || "fin";
        return `<tr class="row--clickable ${a.__fresh ? "row--new" : ""}" data-index="${index}">
          <td class="mono dim">${esc(fmtTime(a.detected_at))}</td>
          <td>${SPORT_ICON[a.sport] || "🏟"} <span class="tag tag--${esc(a.kind)}">${
          KIND_LABEL[a.kind] || esc(a.kind)
        }</span></td>
          <td>
            <div class="event-main">${esc(a.event_title)}</div>
            <div class="event-sub">${esc(a.league || "")}${a.score ? " · " + esc(a.score) : ""}</div>
          </td>
          <td>${esc(a.market_label)}<div class="event-sub">${esc(a.selection_label)}</div></td>
          <td>${isSim(a.provider) ? "🧪 " : ""}${esc(a.bookmaker)}
            <div class="event-sub">${esc(a.provider || "")}</div>
          </td>
          <td class="num"><strong>${fmtOdds(a.odds)}</strong></td>
          <td class="num dim">${fmtOdds(a.fair_odds)}</td>
          <td class="num ${valueClass}">${fmtPct(a.value_percent)}</td>
          <td class="num">${a.confidence ?? "–"}
            <div class="meter"><i class="${
              a.confidence >= 80 ? "good" : a.confidence >= 60 ? "" : "warn"
            }" data-width="${Math.max(0, Math.min(100, a.confidence || 0))}"></i></div>
          </td>
          <td><span class="tag tag--${tag}">${esc(a.status || "?")}</span></td>
          <td>${verdictCell(a)}</td>
        </tr>`;
      })
      .join("");
    applyMeterWidths(body);
    state.alerts.forEach((a) => delete a.__fresh);
    body.querySelectorAll("tr[data-index]").forEach((tr) => {
      tr.addEventListener("click", () => toggleDetail(tr, rows[Number(tr.dataset.index)]));
    });
  }

  /* Ein Alarm ohne Urteil ist nicht "gescheitert", sondern noch nicht
     nachkontrolliert - das muss unterscheidbar bleiben. */
  function verdictCell(a) {
    if (!a.verdict) return '<span class="dim" title="Nachkontrolle steht aus">⏳</span>';
    const v = VERDICT[a.verdict] || { icon: "•", short: a.verdict, tag: "", text: "" };
    const clv = typeof a.clv_percent === "number" ? ` ${fmtPct(a.clv_percent)}` : "";
    return `<span class="tag tag--${v.tag || "fin"}" title="${esc(v.text)}">${v.icon} ${esc(
      v.short
    )}</span><div class="event-sub mono">${clv.trim()}</div>`;
  }

  const COMPONENT_LABEL = {
    deviation: "Abweichung", breadth: "Marktbreite", speed: "Tempo",
    history: "Historie", live: "Live", liquidity: "Liquidität",
    quality: "Datenqualität", freshness: "Aktualität",
  };
  const MODEL_LABEL = {
    median: "Median", margin_removed: "margenbereinigt", weighted_consensus: "Konsens",
  };

  /* Herleitung eines Alarms: gegen welche Preise verglichen wurde, was die
     drei Modelle sagten und welche Signale den Error-Score getragen haben.
     Ohne das muss man dem Ergebnis blind vertrauen. */
  function toggleDetail(row, alert) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("row--detail")) {
      existing.remove();
      return;
    }
    document.querySelectorAll(".row--detail").forEach((el) => el.remove());
    if (!alert) return;

    const refs = Object.entries(alert.references || {}).sort((a, b) => a[1] - b[1]);
    const models = Object.entries(alert.fair_models || {}).filter(([, v]) => v);
    const comps = Object.entries(alert.score_components || {}).sort((a, b) => b[1] - a[1]);

    const block = (title, inner) =>
      inner ? `<div class="detail__block"><h4>${title}</h4>${inner}</div>` : "";

    // Bewegungsmeldungen haben keine faire Quote und damit keine Referenzen -
    // dort ist die Bewegung selbst die Information.
    const movement =
      alert.kind === "odds_move"
        ? `<div class="row"><span class="dim">Vorher</span><span class="mono">${fmtOdds(
            alert.previous_odds
          )}</span></div>
           <div class="row"><span class="dim">Jetzt</span><span class="mono">${fmtOdds(
             alert.odds
           )}</span></div>
           <div class="row"><span class="dim">Änderung</span><span class="mono ${
             alert.deviation_percent >= 0 ? "pos" : "neg"
           }">${fmtPct(alert.deviation_percent)}</span></div>`
        : "";

    const tr = document.createElement("tr");
    tr.className = "row--detail";
    tr.innerHTML = `<td colspan="11"><div class="detail">
      ${block("Bewegung", movement)}
      ${block("Verglichen mit", refs.length
        ? `<div class="chips">${refs
            .map(([n, p]) => `<span class="chip-static">${esc(n)} <b>${p.toFixed(2)}</b></span>`)
            .join("")}</div>`
        : "")}
      ${block("Faire Quote je Modell", models.length
        ? `<div class="chips">${models
            .map(([k, v]) => `<span class="chip-static">${esc(MODEL_LABEL[k] || k)} <b>${v.toFixed(2)}</b></span>`)
            .join("")}</div>`
        : "")}
      ${block("Signale des Error-Scores", comps.length
        ? comps.map(([k, v]) => `<div class="row">
              <span class="dim">${esc(COMPONENT_LABEL[k] || k)}</span>
              <span class="mono">${v.toFixed(1)}</span></div>`).join("")
        : "")}
      ${block("Nachkontrolle", alert.verdict
        ? `<div class="row"><span class="dim">Urteil</span><span>${
            (VERDICT[alert.verdict] || {}).icon || ""
          } ${esc((VERDICT[alert.verdict] || {}).text || alert.verdict)}</span></div>
           <div class="row"><span class="dim">Preis danach</span><span class="mono">${fmtOdds(
             alert.closing_odds
           )}</span></div>
           <div class="row"><span class="dim">Markt danach</span><span class="mono">${fmtOdds(
             alert.closing_fair_odds
           )}</span></div>
           ${
             // Bewegungsalarme haben keine faire Quote - eine leere CLV-Zeile
             // wäre dort nur Rauschen.
             typeof alert.clv_percent === "number"
               ? `<div class="row"><span class="dim">Gegenüber dem Markt</span><span class="mono ${
                   alert.clv_percent >= 0 ? "pos" : "neg"
                 }">${fmtPct(alert.clv_percent)}</span></div>`
               : ""
           }`
        : "")}
      ${block("Hinweise", (alert.notes || []).length
        ? `<ul class="notes">${alert.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
        : "")}
    </div></td>`;
    row.after(tr);
  }

  /* Balkenbreiten per CSSOM setzen statt über style="…".
     Die Content-Security-Policy erlaubt bewusst keine Inline-Styles; das
     Setzen über element.style ist davon nicht betroffen. */
  function applyMeterWidths(root) {
    root.querySelectorAll(".meter > i[data-width]").forEach((bar) => {
      bar.style.width = `${bar.dataset.width}%`;
    });
  }

  function renderMoves() {
    const list = $("moves-list");
    if (!state.moves.length) {
      list.innerHTML = '<li class="empty">Noch keine Bewegungen</li>';
      return;
    }
    list.innerHTML = state.moves
      .map((m) => {
        const cls = m.deviation_percent >= 0 ? "pos" : "neg";
        return `<li>
          <div class="row"><span>${isSim(m.provider) ? "🧪 " : ""}${esc(m.event_title)}</span>
            <span class="mono ${cls}">${fmtPct(m.deviation_percent)}</span></div>
          <div class="row"><span class="dim">${esc(m.market_label)} · ${esc(m.bookmaker)}</span>
            <span class="mono dim">${fmtOdds(m.previous_odds)} → ${fmtOdds(m.odds)}</span></div>
        </li>`;
      })
      .join("");
  }

  function renderEvents() {
    const list = $("live-list");
    const events = [...state.events.values()]
      .filter((e) => e.status === "LIVE")
      .sort((a, b) => (a.sport || "").localeCompare(b.sport || ""));
    $("live-count").textContent = String(events.length);
    if (!events.length) {
      list.innerHTML = '<li class="empty">Keine laufenden Events</li>';
      return;
    }
    list.innerHTML = events
      .slice(0, 40)
      .map((e) => {
        const detail = [];
        if (e.football) {
          if (e.football.minute != null) detail.push(`${e.football.minute}'`);
          if (e.football.period) detail.push(e.football.period);
          const reds = (e.football.home_red_cards || 0) + (e.football.away_red_cards || 0);
          if (reds) detail.push(`🟥 ${e.football.home_red_cards || 0}-${e.football.away_red_cards || 0}`);
        }
        if (e.tennis) {
          if (e.tennis.set_number != null) detail.push(`Satz ${e.tennis.set_number}`);
          if (e.tennis.games_home != null && e.tennis.games_away != null)
            detail.push(`Games ${e.tennis.games_home}-${e.tennis.games_away}`);
          if (e.tennis.points_home != null && e.tennis.points_away != null)
            detail.push(`${e.tennis.points_home}-${e.tennis.points_away}`);
        }
        const score =
          e.score && e.score.home != null && e.score.away != null
            ? `${e.score.home}:${e.score.away}`
            : "";
        return `<li>
          <div class="row">
            <span>${isSim(e.provider) ? "🧪 " : ""}${SPORT_ICON[e.sport] || "🏟"} <strong>${esc(e.home)}</strong> vs <strong>${esc(e.away)}</strong></span>
            <span class="mono">${esc(score)}</span>
          </div>
          <div class="row"><span class="event-sub">${esc(e.league || "")}</span>
            <span class="event-sub mono">${esc(detail.join(" · "))}</span></div>
        </li>`;
      })
      .join("");
  }

  function renderBookmakers() {
    const list = $("books-list");
    const rows = [...state.bookmakers.entries()].sort((a, b) => b[1].count - a[1].count);
    $("books-count").textContent = String(rows.length);
    if (!rows.length) {
      list.innerHTML = '<li class="empty">Noch keine Daten</li>';
      return;
    }
    list.innerHTML = rows
      .slice(0, 20)
      .map(
        ([name, info]) => `<li><div class="row">
            <span>${esc(name)}</span>
            <span class="mono dim">${info.count} Alarme · ⌀ ${fmtPct(info.total / info.count)}</span>
          </div></li>`
      )
      .join("");
  }

  function renderProviders(providers) {
    const list = $("providers-list");
    if (!providers.length) {
      list.innerHTML = '<li class="empty">Keine Provider konfiguriert</li>';
      return;
    }
    // "paused" ist kein Fehler, sondern eine gewollte Pause (z. B. Kontingent
    // aufgebraucht) - deshalb gelb statt rot.
    const DOT = { connected: "dot--on", paused: "dot--warn", degraded: "dot--warn" };

    list.innerHTML = providers
      .map((p) => {
        const dot = p.healthy ? "dot--on" : DOT[p.status] || "dot--off";
        const missing = (p.missing_credentials || []).length
          ? `<div class="event-sub">Fehlt: ${esc(p.missing_credentials.join(", "))}</div>`
          : "";
        // Der Provider weiß selbst am besten, warum er nicht liefert.
        const detail = p.detail
          ? `<div class="event-sub">${esc(p.detail)}</div>`
          : "";
        return `<li>
          <div class="row">
            <span><span class="dot ${dot}"></span> <strong>${esc(p.title)}</strong></span>
            <span class="mono dim">${esc(p.status)}</span>
          </div>
          <div class="row">
            <span class="event-sub">${esc(p.kind)} · ${p.quotes || 0} Quoten · ${p.errors || 0} Fehler</span>
            <span class="event-sub mono">${
              p.rate_limit_remaining != null ? "Kontingent " + p.rate_limit_remaining : ""
            }${p.latency_ms != null ? " · " + p.latency_ms + " ms" : ""}</span>
          </div>${detail}${missing}
        </li>`;
      })
      .join("");
  }

  /* Warnen, solange simulierte Daten im Spiel sind. Ohne diesen Hinweis
     halten Nutzer die erfundenen Partien für echte Spiele. */
  function updateDemoBanner(providers) {
    const simulating = providers.some((p) => p.kind === "mock" && p.healthy);
    const real = providers.filter((p) => p.kind !== "mock" && p.healthy);
    const banner = $("demo-banner");
    banner.hidden = !simulating;
    if (!simulating) return;

    const note = $("demo-banner-text");
    if (real.length) {
      // Der heikle Fall: echte Daten fließen, gehen aber in der Simulation
      // unter. Ohne Hinweis hält man alles für erfunden.
      note.innerHTML =
        "Die Simulation läuft <strong>parallel</strong> zu " +
        real.map((p) => `<strong>${esc(p.title)}</strong>`).join(", ") +
        ". Mit 🧪 markierte Zeilen sind <strong>erfunden</strong>, alle anderen echt. " +
        "Nur echte Daten: <code>PROVIDERS</code> in der <code>.env</code> auf die " +
        "echte Quelle setzen und <code>docker compose up -d</code>.";
    } else {
      note.innerHTML =
        "Die angezeigten Spiele, Teams und Quoten sind <strong>erfunden</strong> und " +
        "existieren nicht in der Wirklichkeit. Der Bot läuft mit dem MockProvider, " +
        "damit du das System ohne Zugangsdaten ausprobieren kannst. Für echte Daten " +
        "<code>PROVIDERS</code> in der <code>.env</code> umstellen – siehe README, " +
        "Abschnitt „Datenquellen konfigurieren“.";
    }
  }

  /* Jede verworfene Quote hat einen Grund. Ohne diese Anzeige sieht ein
     korrekt arbeitendes, aber zu streng eingestelltes System identisch aus
     wie ein kaputtes. */
  function renderSuppressed(stats) {
    const rows = stats.suppressed || [];
    const list = $("suppressed-list");
    $("suppressed-total").textContent = (stats.suppressed_total || 0).toLocaleString("de-DE");
    if (!rows.length) {
      list.innerHTML = '<li class="empty">Noch nichts verworfen</li>';
      return;
    }
    const max = Math.max(...rows.map((r) => r.count));
    list.innerHTML = rows
      .slice(0, 8)
      .map(
        (r) => `<li>
          <div class="row">
            <span>${esc(r.label)}</span>
            <span class="mono dim">${r.count.toLocaleString("de-DE")}</span>
          </div>
          <div class="meter"><i class="warn" data-width="${Math.round((r.count / max) * 100)}"></i></div>
        </li>`
      )
      .join("");
    // Ohne Zeitbezug sagt eine Zahl wie "79.302" nichts aus.
    list.innerHTML +=
      '<li><span class="event-sub">Zähler seit Scanner-Start, Rücksetzung nach 48 h</span></li>';
    applyMeterWidths(list);
  }

  /* Trefferbilanz: die Gegenprobe zum Alarm-Stream. Sie beantwortet die
     einzige Frage, die nach ein paar Stunden wirklich zählt - taugen die
     Meldungen etwas? */
  function renderScorecard(data) {
    const list = $("scorecard-list");
    const rows = data.verdicts || [];
    $("scorecard-resolved").textContent = (data.resolved || 0).toLocaleString("de-DE");

    if (!data.resolved) {
      list.innerHTML =
        '<li class="empty">Noch keine Nachkontrolle abgeschlossen</li>' +
        `<li><span class="event-sub">${
          data.pending
            ? `${data.pending} Alarme warten auf ihre Nachkontrolle.`
            : "Sobald Alarme entstehen, werden sie einige Minuten später erneut gegen den Markt gehalten."
        }</span></li>`;
      return;
    }

    const head = [];
    const scored = data.scored || 0;
    if (data.avg_clv_percent != null && scored >= MIN_SCORED) {
      head.push(`<li><div class="row">
          <span>Ø gegenüber dem späteren Markt <span class="dim">(n=${scored})</span></span>
          <span class="mono ${data.avg_clv_percent >= 0 ? "pos" : "neg"}">${fmtPct(
        data.avg_clv_percent
      )}</span></div></li>`);
      if (data.beat_close_share != null) {
        head.push(`<li><div class="row">
            <span>Besser als der Markt</span>
            <span class="mono dim">${data.beat_close_share.toFixed(0)} % von ${scored}</span>
          </div></li>`);
      }
    } else {
      head.push(`<li><span class="event-sub">Noch kein Durchschnitt: erst ${scored} von
        ${MIN_SCORED} Alarmen sind mit einer Marktreferenz ausgewertet.</span></li>`);
    }

    const max = Math.max(1, ...rows.map((r) => r.count));
    const body = rows.slice(0, 6).map((r) => {
      const v = VERDICT[r.verdict] || { icon: "•", tag: "" };
      return `<li>
        <div class="row">
          <span>${v.icon} ${esc(r.label)}</span>
          <span class="mono dim">${r.count.toLocaleString("de-DE")}</span>
        </div>
        <div class="meter"><i class="${v.tag}" data-width="${Math.round(
        (r.count / max) * 100
      )}"></i></div>
      </li>`;
    });

    list.innerHTML =
      head.join("") +
      body.join("") +
      '<li><span class="event-sub">Der Abstand zum Markt ist <strong>kein Gewinn</strong>. ' +
      "Er zeigt nur, dass ein Preis besser war als der Marktkonsens kurz danach.</span></li>";
    applyMeterWidths(list);
  }

  function renderSystem(health, stats) {
    const list = $("system-list");
    const items = (health.components || []).map(
      (c) => `<li><div class="row">
          <span><span class="dot ${c.healthy ? "dot--on" : "dot--off"}"></span> ${esc(c.name)}</span>
          <span class="mono dim">${c.healthy ? "ok" : esc(c.detail || "Fehler")}</span>
        </div></li>`
    );
    items.push(
      `<li><div class="row"><span>Version</span><span class="mono dim">${esc(
        health.version || "?"
      )} · ${esc(health.environment || "")}</span></div></li>`,
      `<li><div class="row"><span>Laufzeit</span><span class="mono dim">${Math.round(
        health.uptime_seconds || 0
      )}s</span></div></li>`,
      `<li><div class="row"><span>Quoten-Snapshots</span><span class="mono dim">${
        stats.odds_snapshots ?? 0
      }</span></div></li>`
    );
    list.innerHTML = items.join("");
  }

  /* --------------------------------------------------------------- Daten */

  function ingestAlert(alert, fresh) {
    if (!alert || !alert.kind) return;
    const normalized = normalizeAlert(alert);
    normalized.__fresh = !!fresh;
    if (normalized.kind === "odds_move") {
      state.moves.unshift(normalized);
      state.moves = state.moves.slice(0, MAX_MOVES);
      renderMoves();
    }
    state.alerts.unshift(normalized);
    state.alerts = state.alerts.slice(0, MAX_ALERTS * 2);

    if (normalized.kind !== "odds_move") {
      const entry = state.bookmakers.get(normalized.bookmaker) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += normalized.value_percent || 0;
      state.bookmakers.set(normalized.bookmaker, entry);
      renderBookmakers();
    }
    renderAlerts();
  }

  /** WebSocket- und REST-Payloads auf ein Format bringen. */
  function normalizeAlert(raw) {
    if (raw.event && typeof raw.event === "object") {
      const ev = raw.event;
      const score =
        ev.score && ev.score.home != null && ev.score.away != null
          ? `${ev.score.home}:${ev.score.away}`
          : null;
      return {
        kind: raw.kind,
        sport: ev.sport,
        event_id: ev.event_id,
        event_title: `${ev.home} vs ${ev.away}`,
        league: ev.league,
        status: ev.status,
        score,
        market_label: raw.market_label || raw.market,
        selection_label: raw.selection_label || raw.selection,
        bookmaker: raw.bookmaker,
        odds: raw.odds,
        fair_odds: raw.fair_odds,
        value_percent: raw.value_percent,
        deviation_percent: raw.deviation_percent,
        confidence: raw.confidence,
        previous_odds: raw.previous_odds,
        provider: raw.provider,
        detected_at: raw.detected_at,
        notes: raw.notes || [],
        fair_models: raw.fair_models || {},
        score_components: raw.score_components || {},
        references: raw.references || {},
        verdict: raw.verdict || null,
        clv_percent: raw.clv_percent,
        closing_odds: raw.closing_odds,
        closing_fair_odds: raw.closing_fair_odds,
      };
    }
    return { ...raw, detected_at: raw.detected_at };
  }

  /* Urteile entstehen Minuten nach dem Alarm. Der WebSocket liefert nur den
     Alarm selbst, deshalb werden die nachgereichten Urteile beim Auffrischen
     in den vorhandenen Bestand eingemischt - sonst bliebe die Spalte für
     genau die Alarme leer, die man live mitgelesen hat. */
  function mergeVerdicts(rows) {
    if (!state.alerts.length || !rows.length) return;
    const byKey = new Map();
    rows.forEach((row) => {
      if (row.verdict) byKey.set(alertKey(row), row);
    });
    if (!byKey.size) return;
    let changed = false;
    state.alerts.forEach((a) => {
      if (a.verdict) return;
      const match = byKey.get(alertKey(a));
      if (!match) return;
      a.verdict = match.verdict;
      a.clv_percent = match.clv_percent;
      a.closing_odds = match.closing_odds;
      a.closing_fair_odds = match.closing_fair_odds;
      changed = true;
    });
    if (changed) renderAlerts();
  }

  const alertKey = (a) =>
    [a.event_id, a.market_label || a.market, a.selection_label || a.selection, a.bookmaker,
     Math.round(Number(a.odds) * 1000)].join("|");

  async function fetchJson(path) {
    const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  }

  async function refresh() {
    try {
      const [health, stats, providers, events, alerts, scorecard] = await Promise.all([
        fetchJson("/health"),
        fetchJson("/stats"),
        fetchJson("/health/providers"),
        fetchJson("/events?limit=120"),
        fetchJson("/alerts?limit=80"),
        fetchJson("/alerts/scorecard"),
      ]);

      $("kpi-live").textContent = stats.live_events_redis ?? stats.events_live ?? 0;
      $("kpi-tracked").textContent = stats.tracked_events_redis ?? stats.events_total ?? 0;
      $("kpi-alerts").textContent = stats.alerts_window ?? 0;
      $("kpi-value").textContent =
        stats.avg_value_percent != null ? fmtPct(stats.avg_value_percent) : "–";
      $("kpi-books").textContent = stats.bookmakers ?? 0;
      $("kpi-providers").textContent = `${stats.providers_connected ?? 0}/${
        stats.providers_total ?? 0
      }`;

      state.events = new Map(events.map((e) => [e.event_id, e]));
      renderEvents();
      renderProviders(providers);
      updateDemoBanner(providers);
      renderSuppressed(stats);
      renderScorecard(scorecard);
      renderSystem(health, stats);
      // Ein Durchschnitt aus einem einzigen Alarm ist keine Kennzahl, sondern
      // ein Einzelfall. Bis genug ausgewertet ist, bleibt die Kachel leer.
      const clvKpi = $("kpi-clv");
      const enough = (scorecard.scored || 0) >= MIN_SCORED;
      clvKpi.textContent =
        enough && scorecard.avg_clv_percent != null ? fmtPct(scorecard.avg_clv_percent) : "–";
      clvKpi.parentElement.title = enough
        ? `Abstand der gemeldeten Preise zum späteren Marktkonsens, über ${scorecard.scored} Alarme. Kein Gewinn.`
        : `Noch zu wenige ausgewertete Alarme (${scorecard.scored || 0} von ${MIN_SCORED}).`;

      mergeVerdicts(alerts);

      if (!state.alerts.length && alerts.length) {
        state.alerts = alerts.map(normalizeAlert);
        state.moves = state.alerts.filter((a) => a.kind === "odds_move").slice(0, MAX_MOVES);
        state.alerts
          .filter((a) => a.kind !== "odds_move")
          .forEach((a) => {
            const entry = state.bookmakers.get(a.bookmaker) || { count: 0, total: 0 };
            entry.count += 1;
            entry.total += a.value_percent || 0;
            state.bookmakers.set(a.bookmaker, entry);
          });
        renderAlerts();
        renderMoves();
        renderBookmakers();
      }
    } catch (error) {
      console.warn("Aktualisierung fehlgeschlagen:", error.message);
    }
  }

  /* ----------------------------------------------------------- WebSocket */

  function setConnected(connected, text) {
    $("conn-dot").className = `dot ${connected ? "dot--on" : "dot--off"}`;
    $("conn-text").textContent = text;
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = window.STORM_WS_URL || `${proto}://${location.host}/ws`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setConnected(false, "WebSocket blockiert");
      return;
    }
    state.socket = socket;

    socket.onopen = () => {
      setConnected(true, "Live verbunden");
      state.reconnectDelay = 1000;
    };
    socket.onmessage = (message) => {
      let parsed;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (parsed.type === "alert") ingestAlert(parsed.payload, true);
      else if (parsed.type === "event") {
        const ev = parsed.payload;
        if (ev && ev.event_id) {
          state.events.set(ev.event_id, ev);
          renderEvents();
        }
      }
    };
    socket.onclose = () => {
      setConnected(false, "Getrennt — neuer Versuch…");
      // Exponentielles Backoff wie serverseitig, gedeckelt bei 30s.
      setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
    };
    socket.onerror = () => socket.close();
  }

  /* -------------------------------------------------------------- Start */

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("chip--on"));
      chip.classList.add("chip--on");
      state.filter = chip.dataset.filter;
      renderAlerts();
    });
  });

  setInterval(() => {
    $("clock").textContent = new Date().toLocaleTimeString("de-DE", { hour12: false });
  }, 1000);

  // Keep-Alive, damit Proxies die WebSocket-Verbindung nicht kappen.
  setInterval(() => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.send("ping");
  }, 25000);

  setInterval(refresh, 10000);
  refresh();
  connect();
})();

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
      body.innerHTML = '<tr class="empty"><td colspan="10">Keine Alarme für diesen Filter.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map((a) => {
        const valueClass = a.value_percent >= 0 ? "pos" : "neg";
        const tag = STATUS_TAG[a.status] || "fin";
        return `<tr class="${a.__fresh ? "row--new" : ""}">
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
        </tr>`;
      })
      .join("");
    applyMeterWidths(body);
    state.alerts.forEach((a) => delete a.__fresh);
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
    list.innerHTML = providers
      .map((p) => {
        const dot = p.healthy ? "dot--on" : "dot--off";
        const missing = (p.missing_credentials || []).length
          ? `<div class="event-sub">Fehlt: ${esc(p.missing_credentials.join(", "))}</div>`
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
          </div>${missing}
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
      };
    }
    return { ...raw, detected_at: raw.detected_at };
  }

  async function fetchJson(path) {
    const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  }

  async function refresh() {
    try {
      const [health, stats, providers, events, alerts] = await Promise.all([
        fetchJson("/health"),
        fetchJson("/stats"),
        fetchJson("/health/providers"),
        fetchJson("/events?limit=120"),
        fetchJson("/alerts?limit=80"),
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
      renderSystem(health, stats);

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

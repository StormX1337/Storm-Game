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
    // Nimmt die API Wetten an? Kommt aus /stats.
    betlogWrites: false,
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
  /* Alter in Klartext. Auf dem Handy sieht man "09:33:19" und rechnet nicht
     nach - "vor 16 Min" beantwortet dagegen sofort die eigentliche Frage:
     ist das noch aktuell? */
  const fmtAge = (seconds) => {
    if (typeof seconds !== "number" || seconds < 0) return "";
    if (seconds < 60) return `vor ${Math.round(seconds)} s`;
    if (seconds < 3600) return `vor ${Math.round(seconds / 60)} Min`;
    return `vor ${Math.round(seconds / 3600)} h`;
  };
  const ageOf = (value) => {
    const ts = typeof value === "number" ? value : Date.parse(value) / 1000;
    return Number.isNaN(ts) ? null : Date.now() / 1000 - ts;
  };
  const fmtOdds = (value) => (typeof value === "number" ? value.toFixed(2) : "–");
  const fmtPct = (value) =>
    typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "–";

  /* Ab hier ist ein Alarm Geschichte, kein Angebot. Muss zu
     EVENT_STALE_SECONDS im Backend passen. */
  const ALERT_STALE_SECONDS = 180;

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

  /* Empfehlungsgrade. Bewusst dieselben Symbole wie in Telegram - wer beides
     nutzt, soll nicht zweimal etwas lernen müssen. */
  const GRADE = {
    strong: { icon: "🟢", short: "spielen", tag: "good" },
    moderate: { icon: "🟡", short: "klein", tag: "warn" },
    weak: { icon: "⚪", short: "beobachten", tag: "fin" },
    skip: { icon: "⛔", short: "nein", tag: "fin" },
  };

  /* ------------------------------------------------------------ Rendering */

  function alertPasses(alert) {
    const f = state.filter;
    if (f === "all") return true;
    if (f === "football" || f === "tennis") return alert.sport === f;
    // "Spielbar" ist kein Alarmtyp, sondern das Ergebnis der Empfehlung -
    // die Frage "was davon lohnt sich?" in einem Klick.
    if (f === "playable") {
      const r = alert.recommendation;
      return Boolean(r && r.stake_percent > 0);
    }
    return alert.kind === f;
  }

  function renderAlerts() {
    const body = $("alerts-body");
    const rows = state.alerts.filter(alertPasses).slice(0, MAX_ALERTS);
    if (!rows.length) {
      body.innerHTML = '<tr class="empty"><td colspan="12">Keine Alarme für diesen Filter.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map((a, index) => {
        const valueClass = a.value_percent >= 0 ? "pos" : "neg";
        const tag = STATUS_TAG[a.status] || "fin";
        // Die Alarmtabelle ist eine Historie - alte Zeilen gehören dazu.
        // Sie dürfen nur nicht aussehen wie aktuelle: der Preis von vor
        // einer Viertelstunde ist längst weg.
        const age = ageOf(a.detected_at);
        const abgelaufen = age != null && age > ALERT_STALE_SECONDS;
        return `<tr class="row--clickable ${a.__fresh ? "row--new" : ""} ${
          abgelaufen ? "row--stale" : ""
        }" data-index="${index}">
          <td class="mono dim">${esc(fmtTime(a.detected_at))}
            <div class="event-sub">${esc(fmtAge(age))}</div></td>
          <td>${SPORT_ICON[a.sport] || "🏟"} <span class="tag tag--${esc(a.kind)}">${
          KIND_LABEL[a.kind] || esc(a.kind)
        }</span></td>
          <td>
            <div class="event-main">${esc(a.event_title)}</div>
            <div class="event-sub">${esc(a.league || "")}${a.score ? " · " + esc(a.score) : ""}</div>
          </td>
          <td>${esc(a.market_label)}<div class="event-sub">${esc(a.selection_label)}</div></td>
          <td>${esc(a.bookmaker)}
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
          <td>${gradeCell(a)}</td>
          <td><span class="tag tag--${tag}">${esc(a.status || "?")}</span></td>
          <td>${verdictCell(a)}</td>
        </tr>`;
      })
      .join("");
    applyMeterWidths(body);
    renderAlertCards(rows);
    state.alerts.forEach((a) => delete a.__fresh);
    body.querySelectorAll("tr[data-index]").forEach((tr) => {
      tr.addEventListener("click", () => toggleDetail(tr, rows[Number(tr.dataset.index)]));
    });
  }

  /* Dieselben Alarme als Karten. Auf einem 430px breiten Bildschirm bricht
     eine Tabelle mit zwölf Spalten jedes Wort einzeln um - "Ben Shelton vs
     Carlos Alcaraz" wird dort zu sieben Zeilen. Das ist keine Tabelle mehr,
     das ist eine Spalte aus Silben. */
  function renderAlertCards(rows) {
    const list = $("alerts-cards");
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<li class="empty">Keine Alarme für diesen Filter.</li>';
      return;
    }
    list.innerHTML = rows
      .map((a, index) => {
        const age = ageOf(a.detected_at);
        const abgelaufen = age != null && age > ALERT_STALE_SECONDS;
        const tag = STATUS_TAG[a.status] || "fin";
        const valueClass = a.value_percent >= 0 ? "pos" : "neg";
        return `<li class="acard ${abgelaufen ? "acard--stale" : ""}" data-index="${index}">
          <div class="acard__top">
            <span class="tag tag--${esc(a.kind)}">${KIND_LABEL[a.kind] || esc(a.kind)}</span>
            <span class="tag tag--${tag}">${esc(a.status || "?")}</span>
            ${gradeCell(a)}
            <span class="acard__time">${esc(fmtAge(age))}</span>
          </div>
          <div class="acard__title">${SPORT_ICON[a.sport] || "🏟"} ${esc(a.event_title)}</div>
          <div class="acard__sub">${esc(a.league || "")}${
          a.score ? " · " + esc(a.score) : ""
        }</div>
          <div class="acard__sub">${esc(a.market_label)} · <b>${esc(
          a.selection_label
        )}</b> · ${esc(a.bookmaker)}</div>
          <div class="acard__figures">
            <span class="acard__fig"><span>Quote</span><b>${fmtOdds(a.odds)}</b></span>
            <span class="acard__fig"><span>Fair</span><b class="dim">${fmtOdds(
              a.fair_odds
            )}</b></span>
            <span class="acard__fig"><span>Value</span><b class="${valueClass}">${fmtPct(
          a.value_percent
        )}</b></span>
          </div>
          <div class="acard__foot">
            <span class="event-sub">Confidence ${a.confidence ?? "–"}/100</span>
            <span class="event-sub">·</span>
            <span class="event-sub">${verdictCell(a)}</span>
          </div>
        </li>`;
      })
      .join("");
    list.querySelectorAll("li[data-index]").forEach((li) => {
      li.addEventListener("click", () => toggleCardDetail(li, rows[Number(li.dataset.index)]));
    });
  }

  /* Auf der Karte klappt die Herleitung in die Karte selbst auf - eine
     zusätzliche Zeile wie in der Tabelle gibt es hier nicht. */
  function toggleCardDetail(card, alert) {
    const open = card.querySelector(".detail");
    if (open) {
      open.remove();
      return;
    }
    document.querySelectorAll(".acard .detail").forEach((el) => el.remove());
    if (!alert) return;
    card.insertAdjacentHTML("beforeend", detailHtml(alert));
    loadHistory(card, alert);
  }

  /* Was aus dem Alarm folgt. Ein Alarm ohne Empfehlung ist ein alter Alarm -
     das ist etwas anderes als "nicht spielen" und wird auch so gezeigt. */
  function gradeCell(a) {
    const r = a.recommendation;
    if (!r) return '<span class="dim" title="Vor Einführung der Empfehlung entstanden">–</span>';
    // Ein Bewegungsalarm hat keine faire Quote. "Nicht spielen" würde ein
    // Urteil behaupten, das nie gefällt wurde - das ist etwas anderes als
    // "geprüft und verworfen".
    if (r.reason_code === "keine_referenz") {
      return `<span class="dim" title="${esc(r.reason_label || "")}">–</span>`;
    }
    const g = GRADE[r.grade] || { icon: "•", short: r.grade, tag: "fin" };
    const title = r.grade === "skip" || !r.stake_percent ? r.reason_label || "" :
      `Realistischer Vorteil ${fmtPct(r.credible_edge_percent)} (gemeldet ${fmtPct(r.raw_edge_percent)})`;
    const stake = r.stake_percent > 0
      ? `<div class="event-sub mono">${r.stake_percent.toFixed(1)} %</div>` : "";
    return `<span class="tag tag--${g.tag}" title="${esc(title)}">${g.icon} ${esc(
      g.short
    )}</span>${stake}`;
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
  /* Preisstreifen: wo lag der gemeldete Preis im Feld?

     Form ist Betonung, nicht Kategorie - ein Preis ist der Punkt, alle
     anderen sind Kontext. Deshalb ein Akzent und sonst Grau. Ohne dieses
     Bild muss man aus einer Zeile Zahlen im Kopf rekonstruieren, ob der
     Alarm plausibel ist; mit ihm sieht man es.

     Die Zahlen stehen in der Legende, nicht als schwebende Marken am
     Streifen: eine Marke am äußersten Preis ragt sonst über den Rand
     hinaus, und genau dort steht der interessante Fall. */
  function priceStrip(alert) {
    const refs = Object.entries(alert.references || {});
    if (refs.length < 2 || typeof alert.odds !== "number") return "";
    const values = refs.map(([, p]) => p).concat([alert.odds]);
    if (typeof alert.fair_odds === "number" && alert.kind !== "odds_move") {
      values.push(alert.fair_odds);
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    // Alle Preise gleich: dann gibt es keine Streuung zu zeigen, und eine
    // Division durch null wäre der Anfang von NaN im Markup.
    if (!(span > 0)) return "";
    const at = (value) => `${((value - min) / span) * 100}%`;

    const dots = refs
      .sort((a, b) => a[1] - b[1])
      .map(
        ([name, price]) =>
          `<span class="strip__dot" style="left:${at(price)}" title="${esc(name)} ${price.toFixed(
            2
          )}"></span>`
      )
      .join("");
    const hatFair = alert.kind !== "odds_move" && typeof alert.fair_odds === "number";
    const fair = hatFair
      ? `<i class="strip__fair" style="left:${at(alert.fair_odds)}" title="faire Quote ${alert.fair_odds.toFixed(
          2
        )}"></i>`
      : "";

    return `<div class="strip">
      <div class="strip__track">
        ${dots}
        ${fair}
        <span class="strip__flag" style="left:${at(alert.odds)}" title="${esc(
      alert.bookmaker
    )} ${alert.odds.toFixed(2)}"></span>
      </div>
      <div class="strip__scale"><span>${min.toFixed(2)}</span><span>${max.toFixed(2)}</span></div>
      <div class="strip__legend">
        <span><i class="strip__key strip__key--flag"></i>${esc(
          alert.bookmaker
        )} <b>${alert.odds.toFixed(2)}</b></span>
        <span><i class="strip__key strip__key--other"></i>${refs.length} andere Bücher</span>
        ${
          hatFair
            ? `<span><i class="strip__key strip__key--fair"></i>fair <b>${alert.fair_odds.toFixed(
                2
              )}</b></span>`
            : ""
        }
      </div>
    </div>`;
  }

  /* Der Preisverlauf als Sparkline.

     Eine einzelne Zahl sagt nicht, ob die Quote gerade fällt, steht oder
     eben gesprungen ist. Genau das entscheidet aber, ob ein Alarm etwas
     wert ist: ein Preis, der seit zehn Minuten unverändert dasteht, während
     der Markt abrutscht, ist der klassische vergessene Preis.

     Eine Linie, keine Legende - die Überschrift nennt das Buch. */
  function sparkline(points, windowMinutes) {
    const reihe = points
      .filter((p) => !p.suspended)
      .map((p) => ({ t: Date.parse(p.ts) / 1000, preis: p.price }))
      .filter((p) => !Number.isNaN(p.t));
    if (!reihe.length) return "";

    // Ein Preis ändert sich selten, und gespeichert wird nur die Änderung.
    // Über den Index gezeichnet sähen drei Sprünge in zehn Sekunden aus wie
    // eine halbe Stunde gleichmäßiger Bewegung - und ein Preis, der die
    // ganze Zeit stillstand, hätte nur einen Punkt und gar keine Kurve.
    // Beides ist genau der Fall, um den es hier geht. Also: über die Zeit
    // zeichnen und den letzten Preis bis jetzt fortschreiben.
    const jetzt = Date.now() / 1000;
    const von = jetzt - windowMinutes * 60;
    const stufen = [{ t: Math.min(reihe[0].t, von), preis: reihe[0].preis }, ...reihe];
    stufen.push({ t: jetzt, preis: reihe[reihe.length - 1].preis });

    const preise = stufen.map((p) => p.preis);
    const min = Math.min(...preise);
    const max = Math.max(...preise);
    const spanne = max - min || 1;
    const spanneT = stufen[stufen.length - 1].t - stufen[0].t || 1;
    // Etwas Luft oben und unten, sonst klebt die Linie am Rand.
    const y = (preis) => 26 - ((preis - min) / spanne) * 22;
    const x = (t) => ((t - stufen[0].t) / spanneT) * 100;

    // Treppe statt Gerade: zwischen zwei Beobachtungen *stand* der Preis,
    // er wanderte nicht gleichmäßig. Eine schräge Linie behauptete etwas,
    // das wir nicht gesehen haben.
    let d = `M${x(stufen[0].t).toFixed(2)} ${y(stufen[0].preis).toFixed(2)}`;
    for (let i = 1; i < stufen.length; i += 1) {
      d += ` L${x(stufen[i].t).toFixed(2)} ${y(stufen[i - 1].preis).toFixed(2)}`;
      d += ` L${x(stufen[i].t).toFixed(2)} ${y(stufen[i].preis).toFixed(2)}`;
    }
    const steigend = preise[preise.length - 1] >= preise[0];
    return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}" class="spark__line ${steigend ? "spark__line--up" : "spark__line--down"}"
        vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  async function loadHistory(root, alert) {
    const box = root.querySelector("[data-history]");
    if (!box) return;
    // Ohne Buchmacher gäbe es keine Kurve, sondern ein Gemisch aus mehreren
    // Büchern - der Endpunkt lehnt das zu Recht ab.
    if (!alert.market || !alert.selection || !alert.bookmaker) {
      box.innerHTML =
        '<h4>Verlauf</h4><div class="event-sub">Für diesen Alarm ist keine Quotenzeile hinterlegt.</div>';
      return;
    }
    const params = new URLSearchParams({
      event_id: alert.event_id,
      market: alert.market,
      selection: alert.selection,
      minutes: "30",
      bookmaker: alert.bookmaker,
    });
    try {
      const data = await fetchJson(`/odds/history?${params}`);
      const points = data.points || [];
      if (!points.length) {
        box.innerHTML =
          '<h4>Verlauf</h4><div class="event-sub">Noch nichts gespeichert — der Preis wurde erst jetzt gesehen.</div>';
        return;
      }
      // Ein einziger Punkt ist kein Mangel, sondern eine Aussage: der Preis
      // hat sich im ganzen Fenster nicht bewegt. Genau das ist der
      // vergessene Preis.
      const steht = points.length === 1;
      const richtung = data.change_percent >= 0 ? "pos" : "neg";
      box.innerHTML = `<h4>Verlauf · ${esc(alert.bookmaker || "")} · ${data.minutes} Min</h4>
        ${sparkline(points, data.minutes)}
        <div class="row">
          <span class="event-sub mono">${fmtOdds(data.first_price)} → ${fmtOdds(
        data.last_price
      )}</span>
          <span class="event-sub mono ${richtung}">${fmtPct(data.change_percent)}</span>
        </div>
        <div class="event-sub">${
          steht
            ? "unverändert im ganzen Fenster — steht seit mindestens " +
              data.minutes +
              " Min"
            : points.length + " Beobachtungen"
        }</div>`;
    } catch (error) {
      // Ohne Datenbank gibt es keinen Verlauf - das ist kein Defekt.
      box.innerHTML =
        '<h4>Verlauf</h4><div class="event-sub">Nicht abrufbar.</div>';
      console.warn("Verlauf nicht abrufbar -", error);
    }
  }

  /* Die Herleitung eines Alarms - einmal gebaut, von Tabelle und Karte
     gleichermaßen benutzt. Zwei Fassungen desselben Inhalts liefen sonst
     auseinander, sobald jemand nur eine davon pflegt. */
  function detailHtml(alert) {
    const refs = Object.entries(alert.references || {}).sort((a, b) => a[1] - b[1]);
    const models = Object.entries(alert.fair_models || {}).filter(([, v]) => v);
    const comps = Object.entries(alert.score_components || {}).sort((a, b) => b[1] - a[1]);

    const block = (title, inner, extra = "") =>
      inner ? `<div class="detail__block ${extra}"><h4>${title}</h4>${inner}</div>` : "";

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

    const strip = priceStrip(alert);

    return `<div class="detail">
      ${block("Bewegung", movement)}
      ${block("Preis im Feld", strip, "detail__block--wide")}
      <div class="detail__block" data-history="1"><h4>Verlauf</h4><div class="event-sub">Lade…</div></div>
      ${block("Empfehlung", recommendationDetail(alert))}
      ${block("Rechnung", calcRows((alert.recommendation || {}).math, alert.odds))}
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
    </div>`;
  }

  /* Die Empfehlung in der Herleitung: was folgt aus dem Alarm, und warum
     nicht mehr. */
  function recommendationDetail(alert) {
    const r = alert.recommendation;
    if (!r || r.reason_code === "keine_referenz") return "";
    const g = GRADE[r.grade] || { icon: "•", short: r.grade, tag: "fin" };
    const rows = [
      `<div class="row"><span class="dim">Urteil</span>
        <span class="tag tag--${g.tag}">${g.icon} ${esc(r.label || g.short)}</span></div>`,
    ];
    if (r.stake_percent > 0) {
      rows.push(`<div class="row"><span class="dim">Einsatz</span>
        <span class="mono">${r.stake_percent.toFixed(1)} %${
        r.stake_amount ? ` (${r.stake_amount.toFixed(2)})` : ""
      }</span></div>`);
      rows.push(`<div class="row"><span class="dim">Realistischer Vorteil</span>
        <span class="mono pos">${fmtPct(r.credible_edge_percent)}</span></div>`);
    } else if (r.reason_label) {
      rows.push(`<div class="row"><span class="dim">Grund</span><span>${esc(
        r.reason_label
      )}</span></div>`);
    }
    (r.warnings || []).slice(0, 2).forEach((w) => {
      rows.push(`<div class="event-sub">⚠️ ${esc(w)}</div>`);
    });
    return rows.join("");
  }

  function toggleDetail(row, alert) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("row--detail")) {
      existing.remove();
      return;
    }
    document.querySelectorAll(".row--detail").forEach((el) => el.remove());
    if (!alert) return;

    const tr = document.createElement("tr");
    tr.className = "row--detail";
    tr.innerHTML = `<td colspan="12">${detailHtml(alert)}</td>`;
    row.after(tr);
    // Der Verlauf kommt aus der Datenbank und wird erst geholt, wenn jemand
    // die Zeile aufklappt - für achtzig Alarme im Voraus wäre er Ballast.
    loadHistory(tr, alert);
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
          <div class="row"><span>${esc(m.event_title)}</span>
            <span class="mono ${cls}">${fmtPct(m.deviation_percent)}</span></div>
          <div class="row"><span class="dim">${esc(m.market_label)} · ${esc(m.bookmaker)}</span>
            <span class="mono dim">${fmtOdds(m.previous_odds)} → ${fmtOdds(m.odds)}</span></div>
        </li>`;
      })
      .join("");
  }

  function renderEvents() {
    const list = $("live-list");
    // Ein beendetes Spiel meldet kein "beendet" - es hört auf zu erscheinen.
    // Der Server markiert solche Events als `stale`; hier fliegen sie aus der
    // Live-Liste, statt als laufend weiterzustehen.
    const events = [...state.events.values()]
      .filter((e) => e.status === "LIVE" && !e.stale)
      .sort((a, b) => (a.sport || "").localeCompare(b.sport || ""));
    $("live-count").textContent = String(events.length);
    if (!events.length) {
      const veraltet = [...state.events.values()].filter((e) => e.stale).length;
      list.innerHTML = veraltet
        ? `<li class="empty">Keine laufenden Events — ${veraltet} ohne frische Daten (beendet oder Quelle still)</li>`
        : '<li class="empty">Keine laufenden Events</li>';
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
            <span>${SPORT_ICON[e.sport] || "🏟"} <strong>${esc(e.home)}</strong> vs <strong>${esc(e.away)}</strong></span>
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

  /* Die Bestenliste. Wenn nichts übrig bleibt, steht hier *warum* - eine
     leere Kachel ohne Begründung lässt Nutzer an der Anlage zweifeln statt
     am Markt. */
  function renderRecommendations(data) {
    const list = $("picks-list");
    const badge = $("picks-stake");
    const picks = data.picks || [];
    badge.textContent = `${(data.total_stake_percent || 0).toFixed(1)} %`;
    // Genau eine Leitzahl je Ansicht - und zwar die, für die es das
    // Dashboard gibt: wie viele Wetten gerade übrig bleiben.
    $("picks-count").textContent = String(picks.length);
    $("picks-caption").textContent = picks.length
      ? `spielbare ${picks.length === 1 ? "Wette" : "Wetten"} · ${
          data.considered || 0
        } Alarme geprüft`
      : `von ${data.considered || 0} geprüften Alarmen`;

    if (!picks.length) {
      const reasons = (data.dropped || [])
        .slice(0, 5)
        .map((r) => `<li><span class="dim">${esc(r.label)}</span> <b>${r.count}</b></li>`)
        .join("");
      list.innerHTML =
        `<li class="empty">Nichts Spielbares unter ${data.considered || 0} geprüften Alarmen.</li>` +
        (reasons ? `<li class="dim" style="padding-bottom:2px">Warum:</li>${reasons}` : "");
      return;
    }

    list.innerHTML = picks
      .map((pick, index) => {
        const a = pick.alert;
        const r = pick.recommendation;
        const g = GRADE[r.grade] || { icon: "•", short: r.grade, tag: "fin" };
        const amount = r.stake_amount ? ` (≈ ${r.stake_amount.toFixed(2)})` : "";
        const warnings = (r.warnings || [])
          .slice(0, 2)
          .map((w) => `<div class="event-sub">⚠️ ${esc(w)}</div>`)
          .join("");
        return `<li>
          <div class="event-main">
            <span class="tag tag--${g.tag}">${g.icon} ${esc(g.short)}</span>
            <b>${index + 1}. ${esc(a.event_title)}</b>
          </div>
          <div class="event-sub">${esc(a.market_label)} · <b>${esc(
          a.selection_label
        )}</b> · ${esc(a.bookmaker)} · <span class="mono">${fmtOdds(a.odds)}</span></div>
          <div class="event-sub">
            💵 <b>${r.stake_percent.toFixed(1)} %</b> der Bankroll${amount} ·
            Vorteil <b class="${r.credible_edge_percent >= 0 ? "pos" : "neg"}">${fmtPct(
          r.credible_edge_percent
        )}</b> <span class="dim">(gemeldet ${fmtPct(r.raw_edge_percent)})</span>
          </div>
          ${calcRows(r.math, a.odds)}
          ${warnings}
          ${
            // Der Knopf erscheint nur, wenn die API ihn auch annimmt -
            // sonst wäre er eine Einladung in eine Fehlermeldung.
            state.betlogWrites && a.fingerprint
              ? `<button class="chip chip--action" data-bet="${esc(
                  a.fingerprint
                )}">✅ Gespielt</button>`
              : ""
          }
        </li>`;
      })
      .join("");

    list.querySelectorAll("button[data-bet]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        logBet(button);
      });
    });
  }

  /* Die Rechnung in Zahlen, die man vor dem Setzen tatsächlich braucht.
     Prozentwerte beantworten nicht, was das kostet und was zurückkommt. */
  function calcRows(math, odds) {
    if (!math) return "";
    const rows = [];
    if (math.stake_amount && math.payout_amount) {
      rows.push(
        `<span class="calc__row"><span>Einsatz</span><b>${math.stake_amount.toFixed(
          2
        )}</b></span>`,
        `<span class="calc__row"><span>bei Gewinn zurück</span><b>${math.payout_amount.toFixed(
          2
        )}</b></span>`,
        `<span class="calc__row"><span>davon Gewinn</span><b class="pos">+${math.profit_amount.toFixed(
          2
        )}</b></span>`,
        `<span class="calc__row"><span>Erwartungswert</span><b class="${
          math.expected_value_amount >= 0 ? "pos" : "neg"
        }">${math.expected_value_amount >= 0 ? "+" : ""}${math.expected_value_amount.toFixed(
          2
        )}</b></span>`
      );
    } else {
      // Ohne Bankroll keine erfundenen Beträge - die Verhältnisse gelten
      // trotzdem und stehen dann allein da.
      rows.push(
        `<span class="calc__row"><span>Gewinn je 1 Einsatz</span><b class="pos">+${math.profit_per_unit.toFixed(
          2
        )}</b></span>`,
        `<span class="calc__row"><span>Erwartungswert</span><b class="pos">${fmtPct(
          math.expected_value_percent
        )}</b></span>`
      );
    }
    rows.push(
      `<span class="calc__row"><span>Trefferquote nötig</span><b>${math.break_even_percent.toFixed(
        1
      )} %</b></span>`,
      `<span class="calc__row"><span>geschätzt</span><b class="pos">${(
        math.credible_probability * 100
      ).toFixed(1)} %</b></span>`
    );
    return `<div class="calc">${rows.join("")}</div>`;
  }

  /* Sichere Wetten. Anders als überall sonst wird hier nicht geschätzt -
     die Rechnung geht auf, egal wie das Spiel ausgeht. Was nicht aufgeht,
     ist die Annahme, dass beide Preise stehen bleiben, bis beide Wetten
     platziert sind. Deshalb steht das Alter der ältesten Quote dabei.

     Die Karte bleibt verborgen, solange es nichts gibt: eine dauerhaft
     leere Kachel für den Normalfall wäre nur Fläche. */
  function renderArbitrage(data) {
    const card = $("arb-card");
    const list = $("arb-list");
    const badge = $("arb-count");
    if (!card || !list || !badge) return;

    const items = (data && data.items) || [];
    if (!data || !data.enabled || !items.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    badge.textContent = String(items.length);
    list.innerHTML = items
      .slice(0, 8)
      .map((item) => {
        const legs = (item.legs || [])
          .map(
            (leg) => `<span class="chip-static">${esc(
              leg.selection_label || leg.selection
            )} · ${esc(leg.bookmaker)} <b>${leg.odds.toFixed(2)}</b> · ${leg.stake_percent.toFixed(
              1
            )} %</span>`
          )
          .join("");
        return `<li>
          <div class="row">
            <span class="event-main">🔒 ${esc(item.event_title || item.event_id)}</span>
            <span class="mono pos"><b>${fmtPct(item.profit_percent)}</b></span>
          </div>
          <div class="event-sub">${esc(item.market_label || item.market)} · ${esc(
          (item.bookmakers || []).join(" + ")
        )} · älteste Quote ${Math.round(item.max_age || 0)}s</div>
          <div class="chips" style="margin-top:6px">${legs}</div>
        </li>`;
      })
      .join("");
  }

  const BET_ICON = { open: "⏳", won: "✅", lost: "❌", void: "➖" };

  /* Das Wett-Tagebuch: was tatsächlich gespielt wurde.

     Die Trefferbilanz misst, ob die *Alarme* etwas taugten. Hier steht die
     andere Frage: hat es Geld gebracht? Eine Rendite aus einer Handvoll
     Wetten ist allerdings Zufall - deshalb erscheint sie erst, wenn genug
     dahintersteht, und bis dahin nur der Zählerstand. */
  function renderLedger(ledger, bets) {
    const badge = $("ledger-open");
    const summary = $("ledger-summary");
    const list = $("bets-list");
    if (!badge || !summary || !list) return;

    badge.textContent = `${ledger.open_count || 0} offen`;
    const teile = [`<b>${ledger.total || 0}</b> Wetten`];
    if (ledger.settled) {
      teile.push(
        `${ledger.wins}× gewonnen, ${ledger.losses}× verloren` +
          (ledger.voids ? `, ${ledger.voids}× annulliert` : "")
      );
      teile.push(
        `Ergebnis <b class="${ledger.profit >= 0 ? "pos" : "neg"}">${
          ledger.profit >= 0 ? "+" : ""
        }${ledger.profit.toFixed(2)}</b> auf ${ledger.staked.toFixed(2)} Einsatz`
      );
      if (ledger.reliable && ledger.roi_percent != null) {
        teile.push(
          `Rendite <b>${fmtPct(ledger.roi_percent)}</b>` +
            (ledger.expected_roi_percent != null
              ? ` (erwartet war ${fmtPct(ledger.expected_roi_percent)})`
              : "")
        );
      } else if (ledger.settled) {
        teile.push(
          `<span class="dim">Rendite erst ab ${ledger.min_settled} abgerechneten Wetten — darunter ist sie Zufall.</span>`
        );
      }
    } else {
      teile.push("<span class=\"dim\">noch nichts abgerechnet</span>");
    }
    teile.push(`<span class="dim">Einsätze in ${esc(ledger.unit || "Einheiten")}.</span>`);
    summary.innerHTML = teile.join(" · ");

    const rows = bets || [];
    if (!rows.length) {
      list.innerHTML = `<li class="empty">Noch nichts eingetragen — ${
        state.betlogWrites
          ? "oben an einer Empfehlung steht „✅ Gespielt"
          : "im Telegram-Bot steht am Alarm „✅ Gespielt"
      }</li>`;
      return;
    }
    list.innerHTML = rows
      .slice(0, 12)
      .map((bet) => {
        const ergebnis =
          bet.profit == null
            ? '<span class="dim">läuft</span>'
            : `<b class="${bet.profit >= 0 ? "pos" : "neg"}">${
                bet.profit >= 0 ? "+" : ""
              }${bet.profit.toFixed(2)}</b>`;
        return `<li>
          <div class="row">
            <span>${BET_ICON[bet.status] || "•"} <b>${esc(bet.event_title || bet.event_id)}</b></span>
            <span class="mono">${ergebnis}</span>
          </div>
          <div class="row">
            <span class="event-sub">${esc(bet.selection_label || "")} · ${esc(
          bet.bookmaker || ""
        )}</span>
            <span class="event-sub mono">${bet.stake.toFixed(2)} zu ${fmtOdds(bet.odds)}</span>
          </div>
        </li>`;
      })
      .join("");
  }

  /* Eintragen heißt festhalten, nicht setzen. Die Wette landet im Tagebuch;
     platziert wird sie beim Buchmacher, von Hand, wie bisher. */
  async function logBet(button) {
    const fingerprint = button.dataset.bet;
    button.disabled = true;
    button.textContent = "…";
    try {
      const response = await fetch(`${API}/bets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alert_fingerprint: fingerprint }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${response.status}`);
      }
      button.textContent = "📓 Eingetragen";
      refresh();
    } catch (error) {
      // Der Grund gehört an den Knopf, nicht nur in die Konsole.
      button.textContent = "⚠️ ging nicht";
      button.title = String(error.message || error);
      console.warn("Wette eintragen fehlgeschlagen -", error);
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
        // Die Schlüssel, nicht nur die Beschriftungen: der Verlauf fragt
        // damit die Zeitreihe ab. Ohne sie blieb er bei jedem Live-Alarm
        // für immer auf "Lade…" stehen - ausgerechnet bei denen, für die
        // er gebaut wurde.
        market: raw.market,
        selection: raw.selection,
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
        // Leeres Objekt heißt "nicht bewertet" - genauso wie ein fehlendes
        // Feld aus der REST-Antwort. Beides wird zu null, damit die Tabelle
        // "kein Urteil" nicht mit "nicht spielen" verwechselt.
        recommendation:
          raw.recommendation && raw.recommendation.grade ? raw.recommendation : null,
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
    if (!response.ok) {
      const error = new Error(`${path} -> HTTP ${response.status}`);
      error.status = response.status;
      error.path = path;
      throw error;
    }
    return response.json();
  }

  /* Meldet, dass die API älter ist als dieses Dashboard.

     Passiert nach einem `git pull` ohne Neubau: das Dashboard liegt als
     Bind-Mount vor und ist sofort neu, die API steckt im gebauten Image und
     bleibt alt. Sie kennt dann einen Endpunkt noch nicht und antwortet mit
     404. Ohne diesen Hinweis sieht man nur leere Kacheln. */
  function reportVersionMismatch(paths) {
    const banner = $("stale-api");
    if (!paths.length) {
      banner.hidden = true;
      return;
    }
    $("stale-api-paths").textContent = paths.join(", ");
    banner.hidden = false;
  }

  /* Die API antwortet auf keine einzige Anfrage. */
  function reportApiDown(down) {
    const banner = $("api-down");
    if (banner) banner.hidden = !down;
    if (down) {
      ["kpi-live", "kpi-tracked", "kpi-alerts", "kpi-value", "kpi-books",
       "kpi-providers", "kpi-clv"].forEach((id) => {
        const el = $(id);
        if (el) el.textContent = "–";
      });
      const providers = $("providers-list");
      if (providers) {
        providers.innerHTML =
          '<li class="empty">API antwortet nicht — siehe Hinweis oben</li>';
      }
      const system = $("system-list");
      if (system) {
        system.innerHTML =
          '<li class="empty">API antwortet nicht — siehe Hinweis oben</li>';
      }
    }
  }

  /* Welcher Endpunkt füllt welche Kachel. Ohne diese Zuordnung müsste man
     raten, wo ein Ausfall sichtbar wird. */
  const PANEL_OF = {
    stats: ["suppressed-list"],
    providers: ["providers-list"],
    events: ["live-list"],
    alerts: ["alerts-body", "alerts-cards", "moves-list", "books-list"],
    scorecard: ["scorecard-list"],
    arbitrage: ["arb-list"],
    ledger: ["bets-list"],
    bets: ["bets-list"],
    recommendations: ["picks-list"],
    health: ["system-list"],
  };

  function reportFailures(failed) {
    failed.forEach((name) => {
      (PANEL_OF[name] || []).forEach((id) => {
        const el = $(id);
        // Nur ersetzen, was noch nie gefüllt war - alte, echte Daten sind
        // immer noch besser als eine Fehlermeldung.
        if (!el || !el.querySelector(".empty")) return;
        const text = "Nicht abrufbar — API antwortet auf diesen Punkt nicht";
        el.innerHTML =
          el.tagName === "TBODY"
            ? `<tr class="empty"><td colspan="12">${text}</td></tr>`
            : `<li class="empty">${text}</li>`;
      });
    });
    if (failed.includes("recommendations")) {
      const count = $("picks-count");
      if (count && count.textContent === "–") $("picks-caption").textContent = "nicht abrufbar";
    }
  }

  async function refresh() {
    // Bewusst allSettled statt all: ein einzelner fehlschlagender Endpunkt
    // darf nicht das ganze Dashboard leeren. Genau das ist passiert - eine
    // alte API kannte /alerts/scorecard nicht, und daraufhin blieb *jede*
    // Kachel auf "Lade...", auch die, deren Daten längst da waren.
    const requests = {
      health: "/health",
      stats: "/stats",
      providers: "/health/providers",
      events: "/events?limit=120",
      alerts: "/alerts?limit=80",
      scorecard: "/alerts/scorecard",
      recommendations: "/alerts/recommendations?window_minutes=30",
      arbitrage: "/arbitrage",
      ledger: "/bets/ledger",
      bets: "/bets?limit=12",
    };
    const names = Object.keys(requests);
    const settled = await Promise.allSettled(names.map((name) => fetchJson(requests[name])));

    const data = {};
    const missing = [];
    settled.forEach((result, index) => {
      const name = names[index];
      if (result.status === "fulfilled") {
        data[name] = result.value;
        return;
      }
      const error = result.reason || {};
      if (error.status === 404) missing.push(requests[name]);
      console.warn(`Aktualisierung: ${name} fehlgeschlagen -`, error.message || error);
    });
    reportVersionMismatch(missing);
    // Eine Kachel, die für immer "Lade…" zeigt, sieht aus wie beschäftigt -
    // dabei ist sie kaputt. Jeder gescheiterte Endpunkt sagt das jetzt in
    // seiner eigenen Kachel.
    reportFailures(names.filter((name) => !(name in data)));
    // Schlägt *alles* fehl, ist nicht das Dashboard schuld, sondern die API
    // steht nicht. Ohne diesen Hinweis bleiben alle Kacheln stumm auf
    // "Lade…" - und das sieht aus wie ein Fehler im Dashboard.
    reportApiDown(Object.keys(data).length === 0);

    const {
      health,
      stats,
      providers,
      events,
      alerts,
      scorecard,
      recommendations,
      ledger,
      bets,
      arbitrage,
    } = data;

    if (stats) {
      $("kpi-live").textContent = stats.live_events_redis ?? stats.events_live ?? 0;
      $("kpi-tracked").textContent = stats.tracked_events_redis ?? stats.events_total ?? 0;
      $("kpi-alerts").textContent = stats.alerts_window ?? 0;
      $("kpi-value").textContent =
        stats.avg_value_percent != null ? fmtPct(stats.avg_value_percent) : "–";
      $("kpi-books").textContent = stats.bookmakers ?? 0;
      $("kpi-playable").textContent = stats.playable_alerts ?? "–";
      state.betlogWrites = Boolean(stats.betlog_writes);
      $("kpi-providers").textContent = `${stats.providers_connected ?? 0}/${
        stats.providers_total ?? 0
      }`;
      renderSuppressed(stats);
    }

    if (recommendations) renderRecommendations(recommendations);
    if (ledger) renderLedger(ledger, bets || []);
    renderArbitrage(arbitrage);

    if (events) {
      state.events = new Map(events.map((e) => [e.event_id, e]));
      renderEvents();
    }
    if (providers) {
      renderProviders(providers);
    }
    if (health || stats) renderSystem(health || {}, stats || {});

    if (scorecard) {
      renderScorecard(scorecard);
      // Ein Durchschnitt aus einem einzigen Alarm ist keine Kennzahl, sondern
      // ein Einzelfall. Bis genug ausgewertet ist, bleibt die Kachel leer.
      const clvKpi = $("kpi-clv");
      const enough = (scorecard.scored || 0) >= MIN_SCORED;
      clvKpi.textContent =
        enough && scorecard.avg_clv_percent != null ? fmtPct(scorecard.avg_clv_percent) : "–";
      clvKpi.parentElement.title = enough
        ? `Abstand der gemeldeten Preise zum späteren Marktkonsens, über ${scorecard.scored} Alarme. Kein Gewinn.`
        : `Noch zu wenige ausgewertete Alarme (${scorecard.scored || 0} von ${MIN_SCORED}).`;
    }

    if (alerts) {
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

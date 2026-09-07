"""Prometheus-Metriken.

Wird von ``/metrics`` (API) und vom Scanner benutzt. Ein eigener Registry-Satz
pro Prozess ist gewollt - API und Scanner laufen getrennt.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

QUOTES_RECEIVED = Counter("storm_quotes_received_total", "Empfangene Quoten", ["provider"])
QUOTES_CHANGED = Counter(
    "storm_quotes_changed_total", "Quoten mit tatsächlicher Preisänderung", ["provider"]
)
QUOTES_DROPPED = Counter("storm_quotes_dropped_total", "Verworfene Quoten", ["reason"])
ALERTS_EMITTED = Counter("storm_alerts_emitted_total", "Ausgelöste Alarme", ["kind", "sport"])
ALERTS_SUPPRESSED = Counter("storm_alerts_suppressed_total", "Unterdrückte Alarme", ["reason"])
PROVIDER_RECONNECTS = Counter(
    "storm_provider_reconnects_total", "Reconnect-Versuche je Provider", ["provider"]
)
PROVIDER_ERRORS = Counter("storm_provider_errors_total", "Provider-Fehler", ["provider"])
PIPELINE_LATENCY = Histogram(
    "storm_pipeline_latency_seconds",
    "Latenz Provider-Empfang -> Analyse abgeschlossen",
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)
ANALYSIS_LATENCY = Histogram(
    "storm_analysis_latency_seconds",
    "Reine Rechenzeit der Value Engine je Quotenzeile",
    buckets=(0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1),
)
QUEUE_DEPTH = Gauge("storm_queue_depth", "Füllstand der Scanner-Queue")
LIVE_EVENTS = Gauge("storm_live_events", "Aktuell als LIVE erkannte Events")
TRACKED_EVENTS = Gauge("storm_tracked_events", "Insgesamt beobachtete Events")
PROVIDER_UP = Gauge("storm_provider_up", "1 = verbunden, 0 = getrennt", ["provider"])
WS_CLIENTS = Gauge("storm_ws_clients", "Verbundene Dashboard-WebSockets")

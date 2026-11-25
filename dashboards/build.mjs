#!/usr/bin/env node
// Builds the Kakaw dashboards for grafana.gitnasr.com and, with --push, uploads them.
//
//   node dashboards/build.mjs                 writes dashboards/kakaw-*.json
//   GRAFANA_URL=https://grafana.gitnasr.com GRAFANA_TOKEN=glsa_... \
//   node dashboards/build.mjs --push          also uploads them into the "Kakaw" folder
//
// Edit this file, not the JSON: the JSON is regenerated on every run.
//
// Per-layer time and tokens come from the agent's structured logs in Loki
// (`layer_completed`, `llm_response`, `run_completed`) rather than the Mimir
// histogram: the logs carry exact values per call, including calls like
// `title` and `answer` that are not graph layers.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOKI = { type: "loki", uid: "P8E80F9AEF21F6940" };
const MIMIR = { type: "prometheus", uid: "mimir" };
const TEMPO = { type: "tempo", uid: "tempo" };
const FOLDER = { uid: "kakaw", title: "Kakaw" };

const AGENT = '{service_name="kakaw-agent"}';
const ev = (event, fields) => `${AGENT} | event="${event}" | json ${fields}`;

// ── panel helpers ────────────────────────────────────────────────────────────
// Panels are laid out left to right in rows of 24 columns; `row()` starts a new one.

function layout(items) {
  let x = 0, y = 0, rowH = 0, id = 1;
  const panels = [];
  for (const item of items) {
    if (item.type === "row") {
      if (x > 0) { y += rowH; x = 0; rowH = 0; }
      panels.push({ ...item, id: id++, gridPos: { h: 1, w: 24, x: 0, y } });
      y += 1;
      continue;
    }
    const { w, h } = item.size;
    if (x + w > 24) { y += rowH; x = 0; rowH = 0; }
    const { size, ...panel } = item;
    panels.push({ ...panel, id: id++, gridPos: { h, w, x, y } });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return panels;
}

const row = (title) => ({ type: "row", title, collapsed: false, panels: [] });

function target(ds, expr, { legend = "", instant = false, refId = "A" } = {}) {
  const t = { datasource: ds, expr, refId, legendFormat: legend };
  if (ds === LOKI) t.queryType = instant ? "instant" : "range";
  else Object.assign(t, { instant, range: !instant });
  return t;
}

function stat(title, ds, expr, { unit = "short", w = 4, decimals, description, thresholds } = {}) {
  return {
    type: "stat", title, description, datasource: ds, size: { w, h: 4 },
    targets: [target(ds, expr, { instant: true })],
    fieldConfig: {
      defaults: {
        unit, decimals, color: { mode: thresholds ? "thresholds" : "fixed", fixedColor: "blue" },
        thresholds: thresholds ?? { mode: "absolute", steps: [{ color: "blue", value: null }] },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "value", graphMode: "none", textMode: "value" },
  };
}

function timeseries(title, ds, queries, { unit = "short", w = 12, h = 8, stack = false, description } = {}) {
  return {
    type: "timeseries", title, description, datasource: ds, size: { w, h },
    targets: queries.map(([expr, legend], i) => target(ds, expr, { legend, refId: String.fromCharCode(65 + i) })),
    fieldConfig: {
      defaults: {
        unit, min: 0,
        custom: {
          drawStyle: "line", lineInterpolation: "smooth", lineWidth: 2, fillOpacity: stack ? 35 : 10,
          showPoints: "auto", spanNulls: true, stacking: { group: "A", mode: stack ? "normal" : "none" },
        },
      },
      overrides: [],
    },
    options: { legend: { displayMode: "table", placement: "bottom", calcs: ["mean", "max"], showLegend: true }, tooltip: { mode: "multi", sort: "desc" } },
  };
}

function bars(title, ds, expr, legend, { unit = "short", w = 12, h = 8, description } = {}) {
  return {
    type: "bargauge", title, description, datasource: ds, size: { w, h },
    targets: [target(ds, expr, { legend, instant: true })],
    fieldConfig: { defaults: { unit, min: 0, color: { mode: "continuous-BlPu" } }, overrides: [] },
    options: {
      orientation: "horizontal", displayMode: "gradient", showUnfilled: true, valueMode: "color",
      reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
    },
    transformations: [{ id: "sortBy", options: { sort: [{ field: "Value", desc: true }] } }],
  };
}

function pie(title, ds, expr, legend, { w = 6, h = 8, unit = "short", description } = {}) {
  return {
    type: "piechart", title, description, datasource: ds, size: { w, h },
    targets: [target(ds, expr, { legend, instant: true })],
    fieldConfig: { defaults: { unit }, overrides: [] },
    options: {
      pieType: "donut", reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
      legend: { displayMode: "table", placement: "right", values: ["value", "percent"], showLegend: true },
      tooltip: { mode: "single" },
    },
  };
}

function logs(title, expr, { w = 24, h = 10, description } = {}) {
  return {
    type: "logs", title, description, datasource: LOKI, size: { w, h },
    targets: [target(LOKI, expr)],
    options: { showTime: true, wrapLogMessage: true, sortOrder: "Descending", enableLogDetails: true, prettifyLogMessage: false },
  };
}

function traces(title, query, { w = 24, h = 10, description } = {}) {
  return {
    type: "table", title, description, datasource: TEMPO, size: { w, h },
    targets: [{ datasource: TEMPO, refId: "A", queryType: "traceql", query, limit: 50, tableType: "traces" }],
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true, sortBy: [{ displayName: "Duration", desc: true }] },
  };
}

function dashboard(uid, title, description, items, links = []) {
  return {
    uid, title, description, tags: ["kakaw"], timezone: "browser", editable: true,
    schemaVersion: 39, refresh: "1m", time: { from: "now-24h", to: "now" },
    graphTooltip: 1, links, templating: { list: [] }, annotations: { list: [] },
    panels: layout(items),
  };
}

const dashLinks = [{ title: "Kakaw", type: "dashboards", tags: ["kakaw"], asDropdown: false, includeVars: false, keepTime: true }];

// ── Kakaw — Agent ────────────────────────────────────────────────────────────

const layerMs = (agg, range) =>
  `${agg} by (layer) (${agg}_over_time(${ev("layer_completed", "layer, durationMs")} | unwrap durationMs [${range}]))`;
const callTokens = (field, agg, range) =>
  `sum by (layer) (${agg}_over_time(${ev("llm_response", `layer, ${field}`)} | unwrap ${field} [${range}]))`;
const runField = (fn, field, range) =>
  `${fn}(${ev("run_completed", field)} | unwrap ${field} [${range}])`;

const agent = dashboard(
  "kakaw-agent",
  "Kakaw — Agent",
  "Where each question's time and tokens go: per run, per graph layer and per LLM call.",
  [
    row("Per question"),
    stat("Questions", LOKI, `sum(count_over_time(${AGENT} | event="run_completed" [$__range]))`),
    stat("Avg time / question", LOKI, `avg(${runField("avg_over_time", "durationMs", "$__range")})`, { unit: "ms" }),
    stat("p95 time / question", LOKI, `max(quantile_over_time(0.95, ${ev("run_completed", "durationMs")} | unwrap durationMs [$__range]))`, {
      unit: "ms",
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 15000 }, { color: "red", value: 30000 }] },
    }),
    stat("Avg input tokens / question", LOKI, `avg(${runField("avg_over_time", "totalInTokens", "$__range")})`),
    stat("Avg output tokens / question", LOKI, `avg(${runField("avg_over_time", "totalOutTokens", "$__range")})`),
    stat(
      "Provider cache hit",
      LOKI,
      `sum(sum_over_time(${ev("llm_response", "cacheReadTokens")} | unwrap cacheReadTokens [$__range])) / sum(sum_over_time(${ev("llm_response", "inTokens")} | unwrap inTokens [$__range]))`,
      { unit: "percentunit", decimals: 1, description: "Share of input tokens the model provider served from its prompt cache. Higher is cheaper and faster." },
    ),

    row("Where the time goes"),
    bars("Avg time per layer", LOKI, layerMs("avg", "$__range"), "{{layer}}", { unit: "ms" }),
    pie("Share of total time by layer", LOKI, layerMs("sum", "$__range"), "{{layer}}", { unit: "ms", w: 12 }),
    timeseries("Avg layer time", LOKI, [[layerMs("avg", "$__auto"), "{{layer}}"]], { unit: "ms" }),
    timeseries("Time per question", LOKI, [
      [`avg(${runField("avg_over_time", "durationMs", "$__auto")})`, "avg"],
      [`max(quantile_over_time(0.95, ${ev("run_completed", "durationMs")} | unwrap durationMs [$__auto]))`, "p95"],
    ], { unit: "ms" }),

    row("Where the tokens go"),
    bars("Input tokens by LLM call", LOKI, callTokens("inTokens", "sum", "$__range"), "{{layer}}"),
    bars("Output tokens by LLM call", LOKI, callTokens("outTokens", "sum", "$__range"), "{{layer}}", {
      description: "Includes the model's thinking tokens, which are billed as output.",
    }),
    bars("Avg input tokens per call", LOKI, `avg by (layer) (avg_over_time(${ev("llm_response", "layer, inTokens")} | unwrap inTokens [$__range]))`, "{{layer}}"),
    bars("LLM calls by layer", LOKI, `sum by (layer) (count_over_time(${ev("llm_response", "layer")} [$__range]))`, "{{layer}}"),
    timeseries("Input tokens over time", LOKI, [[callTokens("inTokens", "sum", "$__auto"), "{{layer}}"]], { stack: true }),
    timeseries(
      "SQL prompt size (generate)",
      LOKI,
      [[`avg(avg_over_time(${AGENT} | event="llm_call" | json layer, systemPromptLength | layer="generate" | unwrap systemPromptLength [$__auto]))`, "system prompt chars"]],
      { unit: "short", description: "Characters in the generate system prompt. Almost all of it is the schema catalog, so this tracks catalog size per question." },
    ),

    row("Outcomes and model provider"),
    pie("Outcomes", MIMIR, "sum by (outcome) (increase(agent_runs_total[$__range]))", "{{outcome}}", { w: 8 }),
    timeseries("Questions by outcome", MIMIR, [["sum by (outcome) (increase(agent_runs_total[$__rate_interval]))", "{{outcome}}"]], { w: 8, stack: true }),
    timeseries("Gemini call time", MIMIR, [[
      'sum(rate(http_client_request_duration_seconds_sum{job="kakaw-agent",server_address="generativelanguage.googleapis.com"}[$__rate_interval])) / sum(rate(http_client_request_duration_seconds_count{job="kakaw-agent",server_address="generativelanguage.googleapis.com"}[$__rate_interval]))',
      "avg per call",
    ]], { unit: "s", w: 8 }),
    timeseries("Gemini calls by status", MIMIR, [[
      'sum by (http_response_status_code) (increase(http_client_request_duration_seconds_count{job="kakaw-agent",server_address="generativelanguage.googleapis.com"}[$__rate_interval]))',
      "{{http_response_status_code}}",
    ]], { w: 12, stack: true }),
    bars("Model used, by layer", LOKI, `sum by (layer, model) (count_over_time(${AGENT} | event="llm_call" | json layer, model [$__range]))`, "{{layer}} · {{model}}"),

    row("Questions and traces"),
    traces("Slowest questions", '{resource.service.name="kakaw-agent" && name="agent.run"}', {
      description: "Click a trace ID to open the full run: every layer, LLM call and DB query.",
    }),
    logs("Questions asked", `${AGENT} | event="run_started" | json message, userId | line_format "{{.message}}"`, { w: 12 }),
    logs("Completed runs", `${AGENT} | event="run_completed" | json | line_format "{{.durationMs}} ms · in {{.totalInTokens}} · out {{.totalOutTokens}}"`, { w: 12 }),
  ],
  dashLinks,
);

// ── Kakaw — Service health ───────────────────────────────────────────────────

const BE = 'job="kakaw-backend"';
const beHttp = (m) => `http_server_duration_milliseconds_${m}{${BE},http_route!="/api/health"}`;

const service = dashboard(
  "kakaw-service",
  "Kakaw — Service health",
  "Backend API traffic, errors and latency, database calls, outbound calls and resource use for the backend and the agent.",
  [
    row("Backend API"),
    stat("Requests", MIMIR, `sum(increase(${beHttp("count")}[$__range]))`),
    stat("5xx share", MIMIR, `(sum(increase(http_server_duration_milliseconds_count{${BE},http_status_code=~"5.."}[$__range])) or vector(0)) / sum(increase(${beHttp("count")}[$__range]))`, {
      unit: "percentunit", decimals: 2,
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 0.01 }, { color: "red", value: 0.05 }] },
    }),
    stat("p95 latency", MIMIR, `histogram_quantile(0.95, sum by (le) (increase(${beHttp("bucket")}[$__range])))`, { unit: "ms" }),
    stat("Chat request avg", MIMIR, `sum(increase(http_server_duration_milliseconds_sum{${BE},http_route=~".*/messages/stream"}[$__range])) / sum(increase(http_server_duration_milliseconds_count{${BE},http_route=~".*/messages/stream"}[$__range]))`, {
      unit: "ms", description: "One chat message end to end, including the agent run.",
    }),
    stat("Backend memory", MIMIR, `max(process_memory_usage{${BE}})`, { unit: "bytes" }),
    stat("Agent memory", MIMIR, 'max(process_memory_usage{job="kakaw-agent"})', { unit: "bytes" }),
    timeseries("Requests by route", MIMIR, [[`sum by (http_route) (increase(${beHttp("count")}[$__rate_interval]))`, "{{http_route}}"]], { stack: true }),
    timeseries("p95 latency by route", MIMIR, [[`histogram_quantile(0.95, sum by (le, http_route) (rate(${beHttp("bucket")}[$__rate_interval])))`, "{{http_route}}"]], { unit: "ms" }),
    timeseries("Errors by route and status", MIMIR, [[`sum by (http_route, http_status_code) (increase(http_server_duration_milliseconds_count{${BE},http_status_code=~"[45].."}[$__rate_interval]))`, "{{http_status_code}} {{http_route}}"]], { stack: true, w: 24 }),

    row("Databases and outbound calls"),
    timeseries("Backend Postgres time by operation", MIMIR, [[
      `sum by (db_operation_name) (rate(db_client_operation_duration_seconds_sum{${BE}}[$__rate_interval])) / sum by (db_operation_name) (rate(db_client_operation_duration_seconds_count{${BE}}[$__rate_interval]))`,
      "{{db_operation_name}}",
    ]], { unit: "s" }),
    timeseries("Agent queries on customer databases", MIMIR, [[
      'sum by (span_name) (rate(traces_spanmetrics_latency_sum{service="kakaw-agent",span_name=~"mongodb\\\\..*|pg\\\\..*|pg-pool\\\\..*|sqlite.*"}[$__rate_interval])) / sum by (span_name) (rate(traces_spanmetrics_latency_count{service="kakaw-agent",span_name=~"mongodb\\\\..*|pg\\\\..*|pg-pool\\\\..*|sqlite.*"}[$__rate_interval]))',
      "{{span_name}}",
    ]], { unit: "s", description: "Average time per call, from Tempo span metrics." }),
    timeseries("Outbound calls by host", MIMIR, [[
      'sum by (job, server_address) (increase(http_client_request_duration_seconds_count{job=~"kakaw-.*"}[$__rate_interval]))',
      "{{job}} → {{server_address}}",
    ]], { stack: true }),
    timeseries("Outbound call time by host", MIMIR, [[
      'sum by (job, server_address) (rate(http_client_request_duration_seconds_sum{job=~"kakaw-.*"}[$__rate_interval])) / sum by (job, server_address) (rate(http_client_request_duration_seconds_count{job=~"kakaw-.*"}[$__rate_interval]))',
      "{{job}} → {{server_address}}",
    ]], { unit: "s" }),

    row("Resources"),
    timeseries("Memory (RSS)", MIMIR, [['process_memory_usage{job=~"kakaw-.*"}', "{{job}}"]], { unit: "bytes", w: 8 }),
    timeseries("CPU", MIMIR, [['sum by (job) (process_cpu_utilization{job=~"kakaw-.*"})', "{{job}}"]], { unit: "percentunit", w: 8 }),
    timeseries("Event loop delay p99", MIMIR, [['nodejs_eventloop_delay_p99_seconds{job=~"kakaw-.*"}', "{{job}}"]], { unit: "s", w: 8 }),
    timeseries("Heap used", MIMIR, [['sum by (job) (v8js_memory_heap_used_bytes{job=~"kakaw-.*"})', "{{job}}"]], { unit: "bytes" }),
    timeseries("GC time", MIMIR, [['sum by (job) (rate(v8js_gc_duration_seconds_sum{job=~"kakaw-.*"}[$__rate_interval]))', "{{job}}"]], { unit: "percentunit" }),

    row("Logs"),
    timeseries("Warnings and errors", LOKI, [['sum by (service_name, detected_level) (count_over_time({service_name=~"kakaw-.*", detected_level=~"(?i)warn.*|error|fatal"} [$__auto]))', "{{service_name}} {{detected_level}}"]], { w: 24, h: 6, stack: true }),
    logs("Warnings and errors", '{service_name=~"kakaw-.*", detected_level=~"(?i)warn.*|error|fatal"}', { h: 12 }),
  ],
  dashLinks,
);

// ── write and push ───────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const all = [agent, service];
for (const d of all) writeFileSync(join(here, `${d.uid}.json`), JSON.stringify(d, null, 2) + "\n");
console.log(`wrote ${all.map((d) => d.uid + ".json").join(", ")}`);

if (process.argv.includes("--push")) {
  const url = process.env.GRAFANA_URL?.replace(/\/$/, "");
  const token = process.env.GRAFANA_TOKEN;
  if (!url || !token) throw new Error("--push needs GRAFANA_URL and GRAFANA_TOKEN");
  const api = async (method, path, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  if ((await api("GET", `/api/folders/${FOLDER.uid}`)).status === 404) {
    const r = await api("POST", "/api/folders", FOLDER);
    if (r.status >= 300) throw new Error(`folder: ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (const d of all) {
    const r = await api("POST", "/api/dashboards/db", { dashboard: d, folderUid: FOLDER.uid, overwrite: true, message: "build.mjs" });
    if (r.status >= 300) throw new Error(`${d.uid}: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`pushed ${url}${r.body.url}`);
  }
}

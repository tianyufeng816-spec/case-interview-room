"use strict";
/**
 * In-memory session metrics for the live instructor dashboard.
 *
 * Deliberately stores NO transcript text and no message content: only
 * per-session counters, latencies, error kinds, and the final evaluation
 * summary (tier, rationale, per-dimension tiers, strengths/improvements).
 * Everything lives in this process and disappears on restart/redeploy.
 *
 * Every function here is called from request paths, so nothing in this file
 * is allowed to throw — callers wrap in safe() as a second line of defence.
 */

const MAX_SESSIONS = 800;        // oldest sessions are evicted past this
const MAX_SAMPLES_PER_SESSION = 80;
const MAX_ERRORS_PER_SESSION = 6;
const MAX_EVENTS = 400;          // global recent-problem feed
const MAX_GLOBAL_SAMPLES = 4000;

const bootedAt = Date.now();
const sessions = new Map();      // sessionId -> record
const events = [];               // recent problems, newest last
const globalSamples = [];        // {at, ms, endpoint}

function cleanId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : null;
}

function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  while (arr.length > cap) arr.shift();
}

function ensure(sessionId, info) {
  const id = cleanId(sessionId) || "anon-" + (info && info.ip ? String(info.ip).slice(-12).replace(/[^A-Za-z0-9]/g, "") : "x");
  let s = sessions.get(id);
  if (!s) {
    s = {
      id: id,
      name: null,
      questionId: null,
      questionTitle: null,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      candidateTurns: 0,
      chatCalls: 0,
      chatErrors: 0,
      latencies: [],
      ttfb: [],
      errors: [],
      evaluation: null,
      evaluatedAt: null,
      evalMs: null,
      evalError: null
    };
    sessions.set(id, s);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }
  if (info) {
    if (info.name && cleanName(info.name)) s.name = cleanName(info.name);
    if (info.questionId) s.questionId = String(info.questionId).slice(0, 60);
    if (info.questionTitle) s.questionTitle = String(info.questionTitle).slice(0, 80);
  }
  s.lastSeenAt = Date.now();
  return s;
}

function logEvent(sessionId, name, endpoint, kind, message, extra) {
  pushCapped(events, {
    at: Date.now(),
    sessionId: sessionId || null,
    name: name || null,
    endpoint: endpoint,
    kind: kind,
    message: String(message == null ? "" : message).slice(0, 400),
    extra: extra || null
  }, MAX_EVENTS);
}

function recordChat(o) {
  const s = ensure(o.sessionId, o);
  s.chatCalls += 1;
  if (typeof o.candidateTurns === "number" && o.candidateTurns >= 0) {
    s.candidateTurns = Math.max(s.candidateTurns, o.candidateTurns);
  }
  if (o.ok) {
    if (typeof o.ms === "number") {
      pushCapped(s.latencies, o.ms, MAX_SAMPLES_PER_SESSION);
      pushCapped(globalSamples, { at: Date.now(), ms: o.ms, endpoint: "chat" }, MAX_GLOBAL_SAMPLES);
    }
    if (typeof o.ttfbMs === "number") pushCapped(s.ttfb, o.ttfbMs, MAX_SAMPLES_PER_SESSION);
  } else {
    s.chatErrors += 1;
    pushCapped(s.errors, { at: Date.now(), endpoint: "chat", kind: o.errorKind || "error", message: String(o.message || "").slice(0, 200) }, MAX_ERRORS_PER_SESSION);
    logEvent(s.id, s.name, "chat", o.errorKind || "error", o.message, { ms: o.ms, upstreamStatus: o.upstreamStatus || null });
  }
  return s;
}

function recordEvaluate(o) {
  const s = ensure(o.sessionId, o);
  s.evalMs = typeof o.ms === "number" ? o.ms : s.evalMs;
  if (o.ok && o.result) {
    const r = o.result;
    s.evaluation = {
      tier: typeof r.overallTier === "string" ? r.overallTier.slice(0, 40) : "Unknown",
      rationale: typeof r.overallRationale === "string" ? r.overallRationale.slice(0, 400) : "",
      dimensions: Array.isArray(r.dimensions)
        ? r.dimensions.slice(0, 5).map((d) => ({
            name: String((d && d.name) || "").slice(0, 40),
            tier: String((d && d.tier) || "").slice(0, 40)
          }))
        : [],
      strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 4).map((x) => String(x).slice(0, 220)) : [],
      improvements: Array.isArray(r.improvements) ? r.improvements.slice(0, 4).map((x) => String(x).slice(0, 220)) : []
    };
    s.evaluatedAt = Date.now();
    s.evalError = null;
  } else {
    s.evalError = { kind: o.errorKind || "error", message: String(o.message || "").slice(0, 200), at: Date.now() };
    pushCapped(s.errors, { at: Date.now(), endpoint: "evaluate", kind: o.errorKind || "error", message: String(o.message || "").slice(0, 200) }, MAX_ERRORS_PER_SESSION);
    logEvent(s.id, s.name, "evaluate", o.errorKind || "error", o.message, { ms: o.ms, upstreamStatus: o.upstreamStatus || null });
  }
  return s;
}

function recordTranscribe(o) {
  const s = ensure(o.sessionId, o);
  if (!o.ok) {
    pushCapped(s.errors, { at: Date.now(), endpoint: "transcribe", kind: o.errorKind || "error", message: String(o.message || "").slice(0, 200) }, MAX_ERRORS_PER_SESSION);
    logEvent(s.id, s.name, "transcribe", o.errorKind || "error", o.message, { ms: o.ms });
  }
  return s;
}

function recordRateLimit(o) {
  const s = ensure(o.sessionId, o);
  pushCapped(s.errors, { at: Date.now(), endpoint: o.endpoint, kind: "rate_limited", message: "Hit the per-IP limit for " + o.endpoint }, MAX_ERRORS_PER_SESSION);
  logEvent(s.id, s.name, o.endpoint, "rate_limited", "Per-IP rate limit hit on " + o.endpoint, { ip: o.ip ? String(o.ip).slice(0, 45) : null });
  return s;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function latencyStats(values) {
  const arr = values.filter((v) => typeof v === "number" && isFinite(v)).slice().sort((a, b) => a - b);
  return {
    count: arr.length,
    median: pct(arr, 50),
    p95: pct(arr, 95),
    max: arr.length ? arr[arr.length - 1] : null
  };
}

const ACTIVE_WINDOW_MS = 3 * 60 * 1000;   // "live" = seen in the last 3 minutes
const ERROR_WINDOW_MS = 15 * 60 * 1000;

function snapshot(opts) {
  opts = opts || {};
  const now = Date.now();
  const list = [];
  sessions.forEach((s) => {
    const idle = now - s.lastSeenAt;
    let status = "active";
    if (s.evaluation) status = "evaluated";
    else if (s.evalError) status = "eval_failed";
    else if (s.chatErrors > 0 && idle < ACTIVE_WINDOW_MS) status = "active_with_errors";
    else if (idle >= ACTIVE_WINDOW_MS) status = "idle";
    list.push({
      id: s.id,
      name: s.name,
      questionId: s.questionId,
      questionTitle: s.questionTitle,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
      elapsedMs: s.lastSeenAt - s.startedAt,
      idleMs: idle,
      status: status,
      candidateTurns: s.candidateTurns,
      chatCalls: s.chatCalls,
      chatErrors: s.chatErrors,
      latency: latencyStats(s.latencies),
      ttfb: latencyStats(s.ttfb),
      evaluation: s.evaluation,
      evaluatedAt: s.evaluatedAt,
      evalMs: s.evalMs,
      evalError: s.evalError,
      errors: s.errors.slice(-MAX_ERRORS_PER_SESSION)
    });
  });
  list.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  const recentErrors = events.filter((e) => now - e.at < ERROR_WINDOW_MS);
  if (opts.errorsOnly) {
    return {
      ok: true,
      now: now,
      bootedAt: bootedAt,
      errors: events.slice(-120),
      sessionsWithErrors: list.filter((s) => s.chatErrors > 0 || s.evalError || (s.errors && s.errors.length))
    };
  }

  const recentSamples = globalSamples.filter((g) => now - g.at < 10 * 60 * 1000).map((g) => g.ms);
  const tierCounts = {};
  list.forEach((s) => {
    if (s.evaluation && s.evaluation.tier) {
      tierCounts[s.evaluation.tier] = (tierCounts[s.evaluation.tier] || 0) + 1;
    }
  });

  return {
    ok: true,
    now: now,
    bootedAt: bootedAt,
    uptimeMs: now - bootedAt,
    totals: {
      sessions: list.length,
      live: list.filter((s) => s.idleMs < ACTIVE_WINDOW_MS && !s.evaluation).length,
      evaluated: list.filter((s) => !!s.evaluation).length,
      withErrors: list.filter((s) => s.chatErrors > 0 || s.evalError).length,
      chatCalls: list.reduce((a, s) => a + s.chatCalls, 0),
      candidateTurns: list.reduce((a, s) => a + s.candidateTurns, 0)
    },
    latency: {
      allTime: latencyStats(globalSamples.map((g) => g.ms)),
      last10min: latencyStats(recentSamples)
    },
    tierCounts: tierCounts,
    errorCount15min: recentErrors.length,
    errors: events.slice(-60),
    sessions: list
  };
}

function reset() {
  sessions.clear();
  events.length = 0;
  globalSamples.length = 0;
}

function safe(fn) {
  return function () {
    try { return fn.apply(null, arguments); } catch (e) {
      try { console.error("metrics error (ignored)", e && e.message); } catch (e2) { /* ignore */ }
      return null;
    }
  };
}

module.exports = {
  recordChat: safe(recordChat),
  recordEvaluate: safe(recordEvaluate),
  recordTranscribe: safe(recordTranscribe),
  recordRateLimit: safe(recordRateLimit),
  snapshot: safe(snapshot),
  reset: safe(reset),
  cleanName: cleanName,
  cleanId: cleanId
};

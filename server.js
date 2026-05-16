// server.js (ESM) — STAGING ONLY — Minimal & Robust
// Goal: Vapi → /create-booking → TaxiCaller Official Booker API (RC)
// Requirements:
// - No duplicate routes
// - No crashes on TaxiCaller RC 502 / timeout / fetch failed
// - Controlled JSON errors; upstream failures => HTTP 503
// - Keep Vapi tool-calls compatible
// - Works with: node server.js

import express from "express";

console.log("BOOT:", new Date().toISOString());

const app = express();

// =========================
// BODY PARSING
// =========================
// Accept everything as text to avoid express.json() crashes.
// Parse manually in parseBodyOnce().
app.use(express.text({ type: "*/*", limit: "2mb" }));

// =========================
// ENV
// =========================
const PROBE_SECRET = String(process.env.PROBE_SECRET || "");

const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || "");

// TaxiCaller Official API (RC by default for staging)
const TAXICALLER_OFFICIAL_API_BASE_URL = String(
  process.env.TAXICALLER_OFFICIAL_API_BASE_URL || "https://api-rc.taxicaller.net"
);
const TAXICALLER_API_KEY = String(process.env.TAXICALLER_API_KEY || "");
const TAXICALLER_COMPANY_ID = Number(process.env.TAXICALLER_COMPANY_ID || 0);

const TAXICALLER_OFFICIAL_JWT_SUBJECT = String(process.env.TAXICALLER_OFFICIAL_JWT_SUBJECT || "*");
const TAXICALLER_OFFICIAL_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_OFFICIAL_JWT_TTL_SECONDS || 900);

// =========================
// HELPERS
// =========================
function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function requireOfficialEnv() {
  requireEnv("TAXICALLER_API_KEY");
  requireEnv("TAXICALLER_COMPANY_ID");
  if (!TAXICALLER_OFFICIAL_API_BASE_URL) throw new Error("Missing TAXICALLER_OFFICIAL_API_BASE_URL");
}

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function redact(s) {
  const str = String(s ?? "");
  if (!str) return "";
  if (str.length <= 12) return "***";
  return str.slice(0, 6) + "…" + str.slice(-4);
}

function maskPhone(s) {
  const str = String(s ?? "");
  return str.replace(/\d(?=\d{2})/g, "*");
}

function safeJsonSnippet(obj, maxLen = 1200) {
  try {
    const raw = JSON.stringify(obj);
    const masked = raw.replace(/\+?\d[\d\-\s().]{7,}\d/g, (m) => maskPhone(m));
    return masked.length > maxLen ? masked.slice(0, maxLen) + "…" : masked;
  } catch {
    return "[unstringifiable]";
  }
}

function isLikelyE164(phone) {
  return /^\+\d{7,15}$/.test(String(phone || "").trim());
}

function asErrorMessage(e) {
  return String(e?.message || e || "Unknown error");
}

// Parse request body exactly once in a route.
// We use express.text so req.body is usually a string and we JSON.parse manually.
function parseBodyOnce(req) {
  // If some middleware already produced an object (rare here), accept it.
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;

  const raw =
    typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body || "");

  if (!raw) return {};

  // Diagnostic: shows what the server actually receives (helpful for Vapi weird prefixes)
  console.log("[parseBodyOnce] rawHead", {
    len: raw.length,
    head: raw.slice(0, 80),
    codes: Array.from(raw.slice(0, 24)).map((c) => c.charCodeAt(0))
  });

  // Remove BOM + leading control characters (0x00-0x1F)
  const cleanedPrefix = raw.replace(/^\uFEFF/, "").replace(/^[\u0000-\u001F]+/, "");

  // Find first JSON object start
  const i = cleanedPrefix.indexOf("{");
  if (i === -1) throw new Error("Body does not contain JSON object");

  let candidate = cleanedPrefix.slice(i).trim();

  // If JSON got wrapped in quotes, unwrap once.
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }

  return JSON.parse(candidate);
}

function extractVapiToolCall(body) {
  const toolCall = body?.message?.toolCallList?.[0] || null;
  const toolCallId = toolCall?.id || null;

  const argsRaw = toolCall?.function?.arguments;
  let args = {};

  if (argsRaw && typeof argsRaw === "object") args = argsRaw;
  else if (typeof argsRaw === "string") {
    const cleaned = argsRaw.replace(/^\uFEFF/, "").trim();
    if (cleaned) args = JSON.parse(cleaned);
  }

  return { toolCallId, args };
}

function sendVapiOrSimple(res, toolCallId, payload, status = 200) {
  if (toolCallId) return res.status(status).json({ results: [{ toolCallId, result: payload }] });
  return res.status(status).json(payload);
}

function requireProbeSecret(req, res, next) {
  if (!PROBE_SECRET) return res.status(500).json({ ok: false, error: "Missing env var: PROBE_SECRET" });

  const got = String(req.header("x-probe-secret") || "");
  if (got !== PROBE_SECRET) return res.status(401).json({ ok: false, error: "Unauthorized" });

  return next();
}

// =========================
// fetchWithTimeout (stability)
// =========================
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 20000));

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    const msg = asErrorMessage(e);
    if (msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("abort")) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function isTaxiCallerUpstreamFailureMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("official jwt error 502") ||
    m.includes("502 bad gateway") ||
    m.includes("official jwt transport error") ||
    m.includes("booker order transport error") ||
    m.includes("fetch failed") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("connect timeout") ||
    m.includes("timeout after")
  );
}

function sanitizeClientError(message) {
  const msg = String(message || "");

  // If it's upstream RC failure, return a short, clean message
  if (isTaxiCallerUpstreamFailureMessage(msg)) {
    return "TaxiCaller RC temporarily unavailable";
  }

  // Otherwise keep it short (avoid leaking internals)
  if (msg.length > 160) return msg.slice(0, 160) + "…";
  return msg || "Unknown error";
}
// =========================
// GOOGLE MAPS: GEOCODE + DIRECTIONS
// =========================
async function geocode(address) {
  requireEnv("GOOGLE_MAPS_API_KEY");

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({ address, key: GOOGLE_MAPS_API_KEY }).toString();

  const res = await fetchWithTimeout(url, { method: "GET" }, 15000);
  const data = await res.json();

  if (data.status !== "OK" || !data.results?.[0]) {
    throw new Error(`Geocode failed for "${address}": ${data.status}`);
  }

  const loc = data.results[0].geometry.location;
  const formatted = data.results[0].formatted_address;

  return { lat: loc.lat, lon: loc.lng, text: formatted };
}

// TaxiCaller wants [lonE6, latE6] where lon/lat are multiplied by 1e6 and rounded
function toE6([lon, lat]) {
  return [Math.round(lon * 1e6), Math.round(lat * 1e6)];
}

async function directions(from, to) {
  requireEnv("GOOGLE_MAPS_API_KEY");

  const url =
    "https://maps.googleapis.com/maps/api/directions/json?" +
    new URLSearchParams({
      origin: `${from.lat},${from.lon}`,
      destination: `${to.lat},${to.lon}`,
      key: GOOGLE_MAPS_API_KEY
    }).toString();

  const res = await fetchWithTimeout(url, { method: "GET" }, 15000);
  const data = await res.json();

  if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
    throw new Error(`Directions failed: ${data.status}`);
  }

  const leg = data.routes[0].legs[0];

  const dist = leg.distance.value; // meters
  const edur = leg.duration.value; // seconds

  // Flattened E6 points: [lonE6, latE6, lonE6, latE6, ...]
  const pts = [];
  for (const step of leg.steps || []) {
    pts.push(...toE6([step.start_location.lng, step.start_location.lat]));
  }
  pts.push(...toE6([leg.end_location.lng, leg.end_location.lat]));

  return { dist, edur, pts };
}

// =========================
// OFFICIAL JWT (GET /api/v1/jwt/for-key)
// =========================
const OFFICIAL_JWT_RENEW_EARLY_SECONDS = 120;
let officialJwtCache = { token: null, expiresAtMs: 0 };

function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n)) return 900;
  return Math.max(60, Math.min(900, n));
}

async function generateOfficialTaxiCallerJwt({
  sub = TAXICALLER_OFFICIAL_JWT_SUBJECT,
  ttlSeconds = TAXICALLER_OFFICIAL_JWT_TTL_SECONDS
} = {}) {
  requireOfficialEnv();

  const ttl = clampTtl(ttlSeconds);
  const key = String(TAXICALLER_API_KEY || "").trim();

  const base = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, "/api/v1/jwt/for-key");

  // Real URL contains real key — DO NOT log.
  const qs = new URLSearchParams({ key, sub, ttl: String(ttl) }).toString();
  const url = `${base}?${qs}`;

  // Safe log
  const safeQs = new URLSearchParams({ key: redact(key), sub, ttl: String(ttl) }).toString();
  console.log("[OFFICIAL JWT] request", { method: "GET", url: `${base}?${safeQs}` });

  let res;
  let text = "";
  try {
    res = await fetchWithTimeout(url, { method: "GET" }, 15000);
    text = await res.text();
  } catch (e) {
    const message = asErrorMessage(e);
    console.log("[OFFICIAL JWT] transportError", { message });
    throw new Error(`Official JWT transport error: ${message}`);
  }

  console.log("[OFFICIAL JWT] response", {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    bodyPreview: text.slice(0, 240)
  });

  if (!res.ok) {
    // Keep raw HTML/body detail in logs above; throwing is fine (routes sanitize for client)
    throw new Error(`Official JWT error ${res.status}: ${text.slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  const token = data?.token ?? null;
  if (!token || typeof token !== "string") {
    throw new Error(`Official JWT missing token. Response preview: ${safeJsonSnippet(data, 400)}`);
  }

  officialJwtCache.token = token;
  officialJwtCache.expiresAtMs = Date.now() + ttl * 1000;

  console.log("[OFFICIAL JWT] generated", { expiresInSeconds: ttl });
  return token;
}

async function getOfficialTaxiCallerJwt() {
  const now = Date.now();
  const renewAtMs = officialJwtCache.expiresAtMs - OFFICIAL_JWT_RENEW_EARLY_SECONDS * 1000;

  if (officialJwtCache.token && now < renewAtMs) return officialJwtCache.token;

  return await generateOfficialTaxiCallerJwt({
    sub: TAXICALLER_OFFICIAL_JWT_SUBJECT,
    ttlSeconds: TAXICALLER_OFFICIAL_JWT_TTL_SECONDS
  });
}
// =========================
// BOOKER PAYLOAD + CREATE ORDER
// =========================
function buildOfficialBookerOrderPayload({ pickup, dropoff, customerPhone, notes = "" }) {
  const pickupCoords = toE6([pickup.lon, pickup.lat]); // [lonE6, latE6]
  const dropoffCoords = toE6([dropoff.lon, dropoff.lat]);

  return {
    order: {
      company_id: TAXICALLER_COMPANY_ID,
      provider_id: 0,
      items: [
        {
          "@type": "passengers",
          seq: 0,
          passenger: {
            name: "Caller",
            phone: customerPhone,
            email: ""
          },
          client_id: 0,
          account: { id: 0, extra: null },
          require: { seats: 1, wc: 0, bags: 0 },
          pay_info: [{ "@t": 0, data: null }]
        }
      ],
      route: {
        nodes: [
          {
            actions: [{ "@type": "client_action", item_seq: 0, action: "in" }],
            location: { name: pickup.text, coords: pickupCoords },
            times: { arrive: { target: 0, latest: 0 } },
            info: { all: String(notes || "") },
            seq: 0
          },
          {
            actions: [{ "@type": "client_action", item_seq: 0, action: "out" }],
            location: { name: dropoff.text, coords: dropoffCoords },
            times: null,
            info: {},
            seq: 1
          }
        ],
        legs: [
          {
            meta: { dist: 0, est_dur: 0 },
            pts: [],
            from_seq: 0,
            to_seq: 1
          }
        ],
        meta: { dist: 0, est_dur: 0 }
      }
    }
  };
}

async function createBookerOrderOfficial({ pickup_address, destination_address, customer_phone, notes = "" }) {
  requireOfficialEnv();
  requireEnv("GOOGLE_MAPS_API_KEY");

  const phone = String(customer_phone || "").trim();
  if (!isLikelyE164(phone)) {
    return { success: false, error: "customer_phone must be E.164 like +15709290722" };
  }

  const pickupAddress = String(pickup_address || "").trim();
  const dropoffAddress = String(destination_address || "").trim();

  if (!pickupAddress || !dropoffAddress) {
    return { success: false, error: "Missing pickup_address or destination_address" };
  }

  console.log("[OFFICIAL] geocoding pickup...");
  const from = await geocode(pickupAddress);

  console.log("[OFFICIAL] geocoding dropoff...");
  const to = await geocode(dropoffAddress);

  console.log("[OFFICIAL] directions...");
  const r = await directions(from, to);

  // JWT may throw (502/timeout/fetch failed). Caller must catch.
  const jwt = await getOfficialTaxiCallerJwt();

  const payload = buildOfficialBookerOrderPayload({
    pickup: from,
    dropoff: to,
    customerPhone: phone,
    notes
  });

  // Inject route data
  payload.order.route.meta.dist = r.dist;
  payload.order.route.meta.est_dur = r.edur;

  payload.order.route.legs[0].meta.dist = r.dist;
  payload.order.route.legs[0].meta.est_dur = r.edur;
  payload.order.route.legs[0].pts = r.pts;

  const url = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, "/api/v1/booker/order");

  console.log("[OFFICIAL BOOKER] request", {
    method: "POST",
    url,
    customer_phone: maskPhone(phone),
    payloadSnippet: safeJsonSnippet(payload, 1600)
  });

  let res;
  let text = "";
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify(payload)
      },
      25000
    );
    text = await res.text();
  } catch (e) {
    const message = asErrorMessage(e);
    console.log("[OFFICIAL BOOKER] transportError", { message });
    return { success: false, error: `Booker order transport error: ${message}` };
  }

  const safeTextPreview = String(text || "")
    .replace(/"order_token"\s*:\s*"([^"]+)"/, (_m, tok) => `"order_token":"${redact(tok)}"`)
    .slice(0, 600);

  console.log("[OFFICIAL BOOKER] response", {
    status: res.status,
    ok: res.ok,
    bodyPreview: safeTextPreview
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    // Keep detailed preview in logs; routes sanitize for client
    console.log("[OFFICIAL BOOKER] notOk", { status: res.status, bodyPreview: safeTextPreview });
    return { success: false, error: `Booker order error ${res.status}: ${safeTextPreview}` };
  }

  const bookingId = data?.order?.order_id ?? null;
  if (!bookingId) {
    return {
      success: false,
      error: `Missing response.order.order_id. Response preview: ${safeJsonSnippet(data, 800)}`
    };
  }

  return { success: true, booking_id: String(bookingId), eta: "Soon" };
}
// =========================
// ROUTES (single block only)
// =========================

app.get("/routes-check", (_req, res) => {
  return res.status(200).json({
    ok: true,
    env: "staging",
    routes: ["/routes-check", "/taxicaller/official-jwt-check", "/create-booking"]
  });
});

app.get("/taxicaller/official-jwt-check", requireProbeSecret, async (_req, res) => {
  try {
    const token = await getOfficialTaxiCallerJwt();
    return res.status(200).json({
      ok: true,
      hasToken: Boolean(token),
      tokenPreview: token ? redact(token) : null,
      expiresAtMs: officialJwtCache.expiresAtMs
    });
  } catch (e) {
    const rawMessage = asErrorMessage(e);
    const isUpstream = isTaxiCallerUpstreamFailureMessage(rawMessage);

    // Full detail only in logs
    console.log("[/taxicaller/official-jwt-check] ERROR", { rawMessage });

    return res.status(isUpstream ? 503 : 500).json({
      ok: false,
      error: sanitizeClientError(rawMessage),
      upstream: isUpstream ? "taxicaller-rc" : null
    });
  }
});

// =========================
// /create-booking
// =========================
// Accepts:
// - Direct JSON: { pickup_address, destination_address, customer_phone, notes? }
// - Vapi tool-calls payload: body.message.toolCallList[0].function.arguments
//
// Returns:
// - Vapi wrapper when toolCallId exists: { results: [{ toolCallId, result: ... }] }
app.post("/create-booking", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: asErrorMessage(e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  const pickup_address = String(input?.pickup_address || "").trim();
  const destination_address = String(input?.destination_address || "").trim();
  const customer_phone = String(input?.customer_phone || "").trim();
  const notes = input?.notes != null ? String(input.notes) : "";

  console.log("[/create-booking] input", {
    pickup_address,
    destination_address,
    customer_phone: maskPhone(customer_phone),
    notesLen: notes.length,
    toolCallId: toolCallId || null
  });

  try {
    const result = await createBookerOrderOfficial({
      pickup_address,
      destination_address,
      customer_phone,
      notes
    });

    // Structured failure (no throw), sanitize what we return to client
    if (!result?.success) {
      const rawMessage = String(result?.error || "");
      const isUpstream = isTaxiCallerUpstreamFailureMessage(rawMessage);

      // Full detail only in logs
      console.log("[/create-booking] FAIL", { rawMessage });

      const clientPayload = {
        success: false,
        error: sanitizeClientError(rawMessage)
      };

      return sendVapiOrSimple(res, toolCallId, clientPayload, isUpstream ? 503 : 500);
    }

    // Success
    return sendVapiOrSimple(res, toolCallId, result, 200);
  } catch (err) {
    const rawMessage = asErrorMessage(err);
    const isUpstream = isTaxiCallerUpstreamFailureMessage(rawMessage);

    // Full detail only in logs
    console.log("[/create-booking] ERROR", { rawMessage });

    const clientPayload = {
      success: false,
      error: sanitizeClientError(rawMessage)
    };

    return sendVapiOrSimple(res, toolCallId, clientPayload, isUpstream ? 503 : 500);
  }
});

// =========================
// START SERVER
// =========================
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

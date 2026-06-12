/**
 * server.js (ESM) — Minimal & Stable
 * Goal: Vapi → /create-booking → TaxiCaller Official Booker API
 *
 * Kept:
 * - Express
 * - /routes-check
 * - /taxicaller/official-jwt-check (protected by PROBE_SECRET)
 * - /create-booking (supports direct JSON + Vapi tool-calls)
 * - Google geocode + directions
 * - Official JWT via GET /api/v1/jwt/for-key
 * - Booker order via POST /api/v1/booker/order
 */

import express from "express";

console.log("BOOT:", new Date().toISOString());

const app = express();

/**
 * =========================
 * BODY PARSING
 * =========================
 * We accept EVERYTHING as text to avoid express.json() crashes.
 * We JSON.parse manually in parseBodyOnce().
 */
app.use(express.text({ type: "*/*", limit: "2mb" }));

/**
 * =========================
 * ENV
 * =========================
 */
const PROBE_SECRET = String(process.env.PROBE_SECRET || "");

const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || "");

const TAXICALLER_OFFICIAL_API_BASE_URL = String(
  process.env.TAXICALLER_OFFICIAL_API_BASE_URL || "https://api-rc.taxicaller.net"
);
const TAXICALLER_API_KEY = String(process.env.TAXICALLER_API_KEY || "");
const TAXICALLER_COMPANY_ID = Number(process.env.TAXICALLER_COMPANY_ID || 0);

const TAXICALLER_OFFICIAL_JWT_SUBJECT = String(process.env.TAXICALLER_OFFICIAL_JWT_SUBJECT || "*");
const TAXICALLER_OFFICIAL_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_OFFICIAL_JWT_TTL_SECONDS || 900);

/**
 * =========================
 * HELPERS
 * =========================
 */
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

// Parse request body exactly once in a route.
// With express.text("*/*") it should be a string, but we also handle Buffer/other types defensively.
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

  // DIAGNOSTIC: shows what the server actually receives
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
/**
 * =========================
 * GOOGLE MAPS: GEOCODE + DIRECTIONS
 * =========================
 */
async function geocode(address) {
  requireEnv("GOOGLE_MAPS_API_KEY");

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({ address, key: GOOGLE_MAPS_API_KEY }).toString();

  const res = await fetch(url);
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

  const res = await fetch(url);
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

/**
 * =========================
 * OFFICIAL JWT (GET /api/v1/jwt/for-key)
 * =========================
 */
const OFFICIAL_JWT_RENEW_EARLY_SECONDS = 120;
let officialJwtCache = { token: null, expiresAtMs: 0 };
const lastOrderByPhone = new Map(); // phone -> { orderId, createdAtMs }
const LAST_ORDER_TTL_MS = 60 * 60 * 1000; // 60 minutes

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

  const res = await fetch(url, { method: "GET" });
  const text = await res.text();

  console.log("[OFFICIAL JWT] response", {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    bodyPreview: text.slice(0, 240)
  });

  if (!res.ok) throw new Error(`Official JWT error ${res.status}: ${text.slice(0, 400)}`);

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
/**
 * =========================
 * BOOKER PAYLOAD + CREATE ORDER
 * =========================
 */
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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

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
    return { success: false, error: `Booker order error ${res.status}: ${safeTextPreview}` };
  }

  const bookingId = data?.order?.order_id ?? null;
  if (!bookingId) {
    return { success: false, error: `Missing response.order.order_id. Response preview: ${safeJsonSnippet(data, 800)}` };
  }

  return { success: true, booking_id: String(bookingId), eta: "Soon" };
}
/**
 * =========================
 * ROUTES
 * =========================
 */
app.get("/routes-check", (_req, res) => {
  return res.status(200).json({
    ok: true,
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * =========================
 * /create-booking
 * =========================
 * Accepts:
 * - Direct JSON: { pickup_address, destination_address, customer_phone, notes? }
 * - Vapi tool-calls payload
 *
 * Returns:
 * - Vapi wrapper when toolCallId exists: { results: [{ toolCallId, result: ... }] }
 */
app.post("/create-booking", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: String(e?.message || e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  // ---- flujo normal de create_booking ----
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

  const result = await createBookerOrderOfficial({
    pickup_address,
    destination_address,
    customer_phone,
    notes
  });

  if (result.success) {
    console.log("[create-booking] booking_id", result.booking_id);

    const phoneKey = String(customer_phone || "").trim();
    if (phoneKey) {
      lastOrderByPhone.set(phoneKey, { orderId: result.booking_id, createdAtMs: Date.now() });
      console.log("[create-booking] saved lastOrderByPhone", {
        phone: maskPhone(phoneKey),
        orderId: result.booking_id
      });
    }
  }

  return sendVapiOrSimple(res, toolCallId, result, 200);
});
/**
 * =========================
 * /cancel-booking
 * =========================
 * Accepts:
 * - Direct JSON: { caller_phone?, order_id?, reason? }
 * - Vapi tool-calls payload
 *
 * Behavior:
 * - If order_id is provided: cancel that order
 * - Else if caller_phone is provided: cancel most recent order for that phone (from lastOrderByPhone)
 */
app.post("/cancel-booking", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: String(e?.message || e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  const phone = String(input?.caller_phone || input?.customer_phone || "").trim();
  const orderId = String(input?.order_id || "").trim();
  const reason = input?.reason != null ? String(input.reason) : "";

  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: "Invalid phone. Must be E.164 like +15709290722" },
      200
    );
  }

  let resolvedOrderId = orderId;

  if (!resolvedOrderId && phone) {
    const rec = lastOrderByPhone.get(phone);
    if (rec?.orderId) resolvedOrderId = rec.orderId;
  }

  if (!resolvedOrderId) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      {
        success: false,
        error: "MISSING_ORDER_ID",
        message: "No tengo el número de pedido. Dígame el order_id o vuelva a reservar y luego cancelar."
      },
      200
    );
  }

  try {
    requireOfficialEnv();
    const jwt = await getOfficialTaxiCallerJwt();

    const url = joinUrl(
      TAXICALLER_OFFICIAL_API_BASE_URL,
      `/api/v1/booker/order/${encodeURIComponent(resolvedOrderId)}/cancel`
    );

    const tcRes = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ reason })
    });

    const text = await tcRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!tcRes.ok) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: `Cancel error ${tcRes.status}`, data },
        200
      );
    }

    // optional: clear cached last order so it can't be canceled twice
    if (phone) {
      const rec = lastOrderByPhone.get(phone);
      if (rec?.orderId === resolvedOrderId) lastOrderByPhone.delete(phone);
    }

    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: true, order_id: resolvedOrderId, order_status: data?.order_status || data },
      200
    );
  } catch (e) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: String(e?.message || e) },
      200
    );
  }
});
/**
 * =========================
 * /track-booking (by order_id OR caller_phone)
 * =========================
 * Accepts:
 * - Direct JSON: { order_id?, caller_phone? }
 * - Vapi tool-calls payload
 *
 * Behavior:
 * - If order_id is provided: tracks that exact order
 * - Else if caller_phone is provided: tracks the most recent booking for that phone within last 60 minutes
 */
app.post("/track-booking", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: String(e?.message || e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  const caller_phone = String(input?.caller_phone || "").trim();
  let order_id = String(input?.order_id || "").trim();

  // Resolve by phone (most recent order within TTL)
  if (!order_id && caller_phone) {
    const rec = lastOrderByPhone.get(caller_phone);

    if (!rec) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: "No recent booking found for this phone number" },
        200
      );
    }

    const ageMs = Date.now() - rec.createdAtMs;
    if (ageMs > LAST_ORDER_TTL_MS) {
      lastOrderByPhone.delete(caller_phone);
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: "Last booking for this phone number is too old to track automatically" },
        200
      );
    }

    order_id = rec.orderId;
  }

  if (!order_id) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: "Missing order_id or caller_phone" },
      200
    );
  }

  try {
    requireOfficialEnv();
    const jwt = await getOfficialTaxiCallerJwt();

    const url = joinUrl(
      TAXICALLER_OFFICIAL_API_BASE_URL,
      `/api/v1/booker/order/${encodeURIComponent(order_id)}/track`
    );

    const tcRes = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      }
    });

    const text = await tcRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!tcRes.ok) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: `Track error ${tcRes.status}`, data },
        200
      );
    }

    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: true, order_id, track: data?.track || data },
      200
    );
  } catch (e) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: String(e?.message || e) },
      200
    );
  }
});
/**
 * =========================
 * /status-booking (by order_id OR caller_phone)
 * =========================
 * Accepts:
 * - Direct JSON: { order_id?, caller_phone? }
 * - Vapi tool-calls payload
 *
 * Behavior:
 * - If order_id is provided: fetch status for that order
 * - Else if caller_phone is provided: use most recent cached order for that phone (within TTL)
 */
app.post("/status-booking", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: String(e?.message || e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  const caller_phone = String(input?.caller_phone || "").trim();
  let order_id = String(input?.order_id || "").trim();

  // Resolve by phone (most recent order within TTL)
  if (!order_id && caller_phone) {
    const rec = lastOrderByPhone.get(caller_phone);

    if (!rec) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: "No recent booking found for this phone number" },
        200
      );
    }

    const ageMs = Date.now() - rec.createdAtMs;
    if (ageMs > LAST_ORDER_TTL_MS) {
      lastOrderByPhone.delete(caller_phone);
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: "Last booking for this phone number is too old" },
        200
      );
    }

    order_id = rec.orderId;
  }

  if (!order_id) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: "Missing order_id or caller_phone" },
      200
    );
  }

  try {
    requireOfficialEnv();
    const jwt = await getOfficialTaxiCallerJwt();

    const url = joinUrl(
      TAXICALLER_OFFICIAL_API_BASE_URL,
      `/api/v1/booker/order/${encodeURIComponent(order_id)}/status`
    );

    const tcRes = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      }
    });

    const text = await tcRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!tcRes.ok) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: `Status error ${tcRes.status}`, data },
        200
      );
    }

    const order_status = data?.order_status || data;

    // ---- FIXED ETA PARSER ----
    let etaSeconds = null;
    const nodeEtas = order_status?.node_etas;

    if (Array.isArray(nodeEtas) && nodeEtas.length > 0) {
      const pickupEta = nodeEtas.find((n) => n?.seq === 0) || nodeEtas[0];
      const nowSec = Math.floor(Date.now() / 1000);

      // Case A: eta is a NUMBER (seconds)
      if (typeof pickupEta?.eta === "number") {
        etaSeconds = Math.max(0, pickupEta.eta);
      }

      // Case B: eta is an OBJECT with arrive/depart as unix seconds (this is your current TaxiCaller format)
      else if (typeof pickupEta?.eta?.arrive === "number") {
        etaSeconds = Math.max(0, pickupEta.eta.arrive - nowSec);
      }

      // Case C: times.arrive unix seconds (alternate format)
      else if (typeof pickupEta?.times?.arrive === "number") {
        etaSeconds = Math.max(0, pickupEta.times.arrive - nowSec);
      }
    }

    const etaMinutes =
      typeof etaSeconds === "number" ? Math.max(0, Math.round(etaSeconds / 60)) : null;

    // Optional helper fields (nice for the assistant)
    const hasDriver = !!order_status?.resource?.driver?.id;
    const hasVehicle = !!order_status?.resource?.vehicle?.id;

    return sendVapiOrSimple(
      res,
      toolCallId,
      {
        success: true,
        order_id,
        eta_seconds: etaSeconds,
        eta_minutes: etaMinutes,
        has_driver: hasDriver,
        has_vehicle: hasVehicle,
        status: order_status
      },
      200
    );
  } catch (e) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: String(e?.message || e) },
      200
    );
  }
});
// =========================
// /fare-estimate
// =========================
// Input (direct JSON or Vapi tool-calls):
// { pickup_address, destination_address, passengers?, customer_phone? }
//
// Output:
// { success, estimated_fare_amount, currency, eta_minutes, pickup_address, destination_address }
app.post("/fare-estimate", async (req, res) => {
  let body;
  try {
    body = parseBodyOnce(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON_BODY",
      message: String(e?.message || e)
    });
  }

  const { toolCallId, args } = extractVapiToolCall(body);
  const input = toolCallId ? args : body;

  const pickup_address = String(input?.pickup_address || "").trim();
  const destination_address = String(input?.destination_address || "").trim();
  const passengers = Number.isFinite(Number(input?.passengers)) ? Number(input.passengers) : 1;

  // Prefer explicit customer_phone; else use caller id from Vapi if present
  const customer_phone =
    String(input?.customer_phone || "").trim() ||
    String(input?.caller_phone || "").trim() ||
    "+10000000000";

  if (!pickup_address || !destination_address) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: "Missing pickup_address or destination_address" },
      200
    );
  }

  try {
    requireOfficialEnv();
    const jwt = await getOfficialTaxiCallerJwt();

    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleKey) throw new Error("Missing GOOGLE_MAPS_API_KEY");

    const companyId = Number(process.env.TAXICALLER_COMPANY_ID);
    if (!Number.isFinite(companyId)) throw new Error("Missing TAXICALLER_COMPANY_ID");

    // 1) Geocode pickup + destination
    const geocode = async (address) => {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleKey}`;
      const r = await fetch(url);
      const j = await r.json();
      const loc = j?.results?.[0]?.geometry?.location;
      if (!loc) throw new Error(`Could not geocode address: ${address}`);
      return { lat: loc.lat, lng: loc.lng, formatted: j.results[0].formatted_address };
    };

    const [p, d] = await Promise.all([geocode(pickup_address), geocode(destination_address)]);

    // TaxiCaller wants coords as [Long, Lat] with *1e6
    const toTcCoords = ({ lat, lng }) => [Math.round(lng * 1e6), Math.round(lat * 1e6)];

    // 2) Distance Matrix for dist(m) + dur(s)
const dmUrl =
  `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${p.lat},${p.lng}&destinations=${d.lat},${d.lng}&key=${googleKey}`;
const dmRes = await fetch(dmUrl);
const dmText = await dmRes.text();

let dm;
try { dm = JSON.parse(dmText); } catch { dm = { raw: dmText }; }

const el = dm?.rows?.[0]?.elements?.[0];
const elementStatus = el?.status;

if (dm?.status !== "OK" || elementStatus !== "OK") {
  return sendVapiOrSimple(
    res,
    toolCallId,
    {
      success: false,
      error: "GOOGLE_DISTANCE_MATRIX_FAILED",
      google: {
        httpStatus: dmRes.status,
        status: dm?.status,
        error_message: dm?.error_message,
        elementStatus,
        origin: `${p.lat},${p.lng}`,
        destination: `${d.lat},${d.lng}`
      }
    },
    200
  );
}

const distMeters = el.distance.value;
const durSeconds = el.duration.value;

    // 3) Build minimal TaxiCaller availability payload
    const nowSec = Math.floor(Date.now() / 1000);

    const payload = {
      order: {
        company_id: companyId,
        provider_id: 0, // let system resolve via slots (TaxiCaller still returns slots with provider_id)
        items: [
          {
            "@type": "passengers",
            seq: 0,
            passenger: {
              name: "Caller",
              phone: customer_phone,
              email: null
            },
            client_id: 42,
            account: null,
            require: { seats: Math.max(1, passengers), wc: 0, bags: 0 },
            pay_info: [{ "@t": 0, data: null }],
            custom_fields: {}
          }
        ],
        route: {
          nodes: [
            {
              actions: [{ "@type": "client_action", item_seq: 0, action: "in" }],
              location: { name: p.formatted, coords: toTcCoords(p) },
              times: { arrive: { target: nowSec, latest: 0 } },
              info: { all: "" },
              seq: 0
            },
            {
              actions: [{ "@type": "client_action", item_seq: 0, action: "out" }],
              location: { name: d.formatted, coords: toTcCoords(d) },
              times: null,
              info: {},
              seq: 1
            }
          ],
          legs: [
            {
              meta: { dist: distMeters, est_dur: durSeconds },
              pts: [],
              from_seq: 0,
              to_seq: 1
            }
          ],
          meta: { dist: distMeters, est_dur: durSeconds }
        }
      }
    };

    const url = joinUrl(
      process.env.TAXICALLER_OFFICIAL_API_BASE_URL,
      `/api/v1/booker/availability/order`
    );

    const tcRes = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify(payload)
    });

    const text = await tcRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!tcRes.ok) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: `Availability error ${tcRes.status}`, data },
        200
      );
    }

    const slots = Array.isArray(data?.slots) ? data.slots : [];
    const slot = slots.find(s => s?.fare_quote?.amount != null) || slots[0];

    if (!slot || slot?.fare_quote?.amount == null) {
      return sendVapiOrSimple(
        res,
        toolCallId,
        { success: false, error: "No fare quote returned", data },
        200
      );
    }

    const amount = slot.fare_quote.amount;
    const currency = slot.fare_quote.currency || null;

    const etaUnix = slot.eta;
    const eta_minutes = typeof etaUnix === "number"
      ? Math.max(0, Math.round((etaUnix - nowSec) / 60))
      : null;

    return sendVapiOrSimple(
      res,
      toolCallId,
      {
        success: true,
        pickup_address: p.formatted,
        destination_address: d.formatted,
        estimated_fare_amount: amount,
        currency,
        eta_minutes
      },
      200
    );
  } catch (e) {
    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: String(e?.message || e) },
      200
    );
  }
});
/**
 * =========================
 * START SERVER
 * =========================
 */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

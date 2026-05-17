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
app.use(express.text({ type: "*/*", limit: "2mb" }));

// =========================
// ENV
// =========================
const PROBE_SECRET = String(process.env.PROBE_SECRET || "");
const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || "");

// Google Sheets (staging logging)
const ENABLE_GOOGLE_SHEETS_LOG =
  String(process.env.ENABLE_GOOGLE_SHEETS_LOG || "").toLowerCase() === "true";
const GOOGLE_SERVICE_ACCOUNT_JSON = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "");
const GOOGLE_SHEETS_SPREADSHEET_ID = String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "");
const GOOGLE_SHEETS_SHEET_NAME = String(process.env.GOOGLE_SHEETS_SHEET_NAME || "Bookings");

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
  if (!TAXICALLER_OFFICIAL_API_BASE_URL) {
    throw new Error("Missing TAXICALLER_OFFICIAL_API_BASE_URL");
  }
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

function sanitizeClientError(message) {
  const m = String(message || "");
  return m.length > 240 ? m.slice(0, 240) + "…" : m;
}

// classify TaxiCaller/network failures as upstream => 503
function isTaxiCallerUpstreamFailureMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("taxicaller") ||
    m.includes("api-rc.taxicaller.net") ||
    m.includes("official jwt error") ||
    m.includes("booker order error") ||
    m.includes("transport error") ||
    m.includes("fetch failed") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("etimedout") ||
    m.includes("timeout") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504")
  );
}

// Parse request body exactly once in a route.
function parseBodyOnce(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw =
    typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body || "");

  if (!raw) return {};

  console.log("[parseBodyOnce] rawHead", {
    len: raw.length,
    head: raw.slice(0, 80),
    codes: Array.from(raw.slice(0, 24)).map((c) => c.charCodeAt(0))
  });

  const cleanedPrefix = raw.replace(/^\uFEFF/, "").replace(/^[\u0000-\u001F]+/, "");
  const i = cleanedPrefix.indexOf("{");
  if (i === -1) throw new Error("Body does not contain JSON object");

  let candidate = cleanedPrefix.slice(i).trim();

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

  if (argsRaw && typeof argsRaw === "object") {
    args = argsRaw;
  } else if (typeof argsRaw === "string") {
    const cleaned = argsRaw.replace(/^\uFEFF/, "").trim();
    if (cleaned) args = JSON.parse(cleaned);
  }

  return { toolCallId, args };
}

function sendVapiOrSimple(res, toolCallId, payload, status = 200) {
  if (toolCallId) {
    return res.status(status).json({ results: [{ toolCallId, result: payload }] });
  }
  return res.status(status).json(payload);
}

function requireProbeSecret(req, res, next) {
  if (!PROBE_SECRET) {
    return res.status(500).json({ ok: false, error: "Missing env var: PROBE_SECRET" });
  }

  const got = String(req.header("x-probe-secret") || "");
  if (got !== PROBE_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

// =========================
// fetchWithTimeout (stability)
// =========================
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Number(timeoutMs) || 20000);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    const msg = asErrorMessage(e);
    if (msg.toLowerCase().includes("aborted")) {
      throw new Error(`fetch timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}

// =========================
// GOOGLE SHEETS (Manual Review Logging) — STAGING ONLY
// =========================
let googleSheetsTokenCache = { token: null, expiresAtMs: 0 };

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getGoogleAccessToken() {
  if (!ENABLE_GOOGLE_SHEETS_LOG) return null;

  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing env var: GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  const now = Date.now();
  if (googleSheetsTokenCache.token && now < googleSheetsTokenCache.expiresAtMs - 60_000) {
    return googleSheetsTokenCache.token;
  }

  let sa;
  try {
    sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const clientEmail = sa.client_email;
  const privateKey = sa.private_key;

  if (!clientEmail || !privateKey) {
    throw new Error("Service account JSON missing client_email/private_key");
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp
  };

  const unsignedJwt =
    `${base64UrlEncode(JSON.stringify(header))}.` +
    `${base64UrlEncode(JSON.stringify(claimSet))}`;

  const { createSign } = await import("crypto");
  const signature = createSign("RSA-SHA256").update(unsignedJwt).sign(privateKey);

  const signedJwt = `${unsignedJwt}.${base64UrlEncode(signature)}`;

  const tokenRes = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJwt
      }).toString()
    },
    12000
  );

  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    throw new Error(`Google OAuth token error ${tokenRes.status}: ${tokenText.slice(0, 240)}`);
  }

  const tokenData = JSON.parse(tokenText);
  const token = tokenData.access_token;
  const expiresIn = Number(tokenData.expires_in || 3600);

  if (!token) throw new Error("Google OAuth token response missing access_token");

  googleSheetsTokenCache.token = token;
  googleSheetsTokenCache.expiresAtMs = Date.now() + expiresIn * 1000;

  return token;
}

async function appendBookingRowToSheets(row) {
  if (!ENABLE_GOOGLE_SHEETS_LOG) return;

  if (!GOOGLE_SHEETS_SPREADSHEET_ID) {
    console.log("[SHEETS] disabled/misconfigured", { reason: "Missing GOOGLE_SHEETS_SPREADSHEET_ID" });
    return;
  }

  try {
    const token = await getGoogleAccessToken();
    if (!token) return;

    const range = `${GOOGLE_SHEETS_SHEET_NAME}!A:K`;
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/` +
      `${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}/values/` +
      `${encodeURIComponent(range)}:append?` +
      `valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const values = [[
      row.created_at || "",
      row.customer_phone || "",
      row.pickup_address || "",
      row.destination_address || "",
      row.appointment_time || "",
      row.notes || "",
      row.taxicaller_success ? "TRUE" : "FALSE",
      row.booking_id || "",
      row.manual_needed ? "TRUE" : "FALSE",
      row.error || "",
      row.source || "vapi"
    ]];

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ values })
      },
      12000
    );

    const respText = await resp.text();
    if (!resp.ok) {
      console.log("[SHEETS] append failed", { status: resp.status, bodyPreview: respText.slice(0, 240) });
      return;
    }

    console.log("[SHEETS] appended", { ok: true });
  } catch (e) {
    console.log("[SHEETS] append error (non-fatal)", { message: asErrorMessage(e) });
  }
}

// =========================
// GOOGLE MAPS: GEOCODE + DIRECTIONS
// =========================
async function geocode(address) {
  requireEnv("GOOGLE_MAPS_API_KEY");

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({ address, key: GOOGLE_MAPS_API_KEY }).toString();

  const res = await fetchWithTimeout(url, { method: "GET" }, 20000);
  const data = await res.json();

  if (data.status !== "OK" || !data.results?.[0]) {
    throw new Error(`Geocode failed for "${address}": ${data.status}`);
  }

  const loc = data.results[0].geometry.location;
  const formatted = data.results[0].formatted_address;

  return { lat: loc.lat, lon: loc.lng, text: formatted };
}

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

  const res = await fetchWithTimeout(url, { method: "GET" }, 20000);
  const data = await res.json();

  if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
    throw new Error(`Directions failed: ${data.status}`);
  }

  const leg = data.routes[0].legs[0];

  const dist = leg.distance.value; // meters
  const edur = leg.duration.value; // seconds

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
  const qs = new URLSearchParams({ key, sub, ttl: String(ttl) }).toString();
  const url = `${base}?${qs}`;

  const safeQs = new URLSearchParams({ key: redact(key), sub, ttl: String(ttl) }).toString();
  console.log("[OFFICIAL JWT] request", { method: "GET", url: `${base}?${safeQs}` });

  const res = await fetchWithTimeout(url, { method: "GET" }, 20000);
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

// =========================
// BOOKER PAYLOAD + CREATE ORDER
// =========================
function buildOfficialBookerOrderPayload({ pickup, dropoff, customerPhone, notes = "" }) {
  const pickupCoords = toE6([pickup.lon, pickup.lat]);
  const dropoffCoords = toE6([dropoff.lon, dropoff.lat]);

  return {
    order: {
      company_id: TAXICALLER_COMPANY_ID,
      provider_id: 0,
      items: [
        {
          "@type": "passengers",
          seq: 0,
          passenger: { name: "Caller", phone: customerPhone, email: "" },
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
        legs: [{ meta: { dist: 0, est_dur: 0 }, pts: [], from_seq: 0, to_seq: 1 }],
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

  let jwt;
  try {
    jwt = await getOfficialTaxiCallerJwt();
  } catch (e) {
    return { success: false, error: `Official JWT error: ${asErrorMessage(e)}` };
  }

  const payload = buildOfficialBookerOrderPayload({
    pickup: from,
    dropoff: to,
    customerPhone: phone,
    notes
  });

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
    return { success: false, error: `Booker order transport error: ${asErrorMessage(e)}` };
  }

  const safeTextPreview = String(text || "")
    .replace(/"order_token"\s*:\s*"([^"]+)"/, (_m, tok) => `"order_token":"${redact(tok)}"`)
    .slice(0, 600);

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

// =========================
// ROUTES
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

  const created_at = new Date().toISOString();
  const source = "vapi";
  const appointment_time = String(input?.appointment_time || "").trim();

  console.log("[/create-booking] input", {
    pickup_address,
    destination_address,
    customer_phone: maskPhone(customer_phone),
    notesLen: notes.length,
    toolCallId: toolCallId || null
  });

  let result;
  try {
    result = await createBookerOrderOfficial({
      pickup_address,
      destination_address,
      customer_phone,
      notes
    });
  } catch (err) {
    const rawMessage = asErrorMessage(err);
    console.log("[/create-booking] ERROR (thrown)", { rawMessage });
    result = { success: false, error: rawMessage };
  }

  if (!result?.success) {
    const rawMessage = String(result?.error || "");
    const isUpstream = isTaxiCallerUpstreamFailureMessage(rawMessage);

    appendBookingRowToSheets({
      created_at,
      customer_phone,
      pickup_address,
      destination_address,
      appointment_time,
      notes,
      taxicaller_success: false,
      booking_id: "",
      manual_needed: true,
      error: sanitizeClientError(rawMessage),
      source
    });

    return sendVapiOrSimple(
      res,
      toolCallId,
      { success: false, error: sanitizeClientError(rawMessage) },
      isUpstream ? 503 : 500
    );
  }

  appendBookingRowToSheets({
    created_at,
    customer_phone,
    pickup_address,
    destination_address,
    appointment_time,
    notes,
    taxicaller_success: true,
    booking_id: result?.booking_id || "",
    manual_needed: false,
    error: "",
    source
  });

  return sendVapiOrSimple(res, toolCallId, result, 200);
});

// =========================
// START SERVER
// =========================
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

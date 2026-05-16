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
import { google } from "googleapis"; // <-- STAGING: Google Sheets support (helpers added in Part 2)

console.log("BOOT:", new Date().toISOString());
console.log("STAGING_BUILD_TAG:", "sheets-debug-v1"); // <-- ADD THIS LINE (staging only)

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

=========================
GOOGLE SHEETS (STAGING ONLY)
=========================
Controlled by:
ENVIRONMENT=staging
ENABLE_GOOGLE_SHEETS_LOG=true
Required env:
GOOGLE_SERVICE_ACCOUNT_JSON (FULL JSON)
GOOGLE_SHEETS_SPREADSHEET_ID
GOOGLE_SHEETS_SHEET_NAME (optional; default "Bookings")
*/
function envBool(name, defaultValue = false) {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(v);
}
function isStagingEnv() {
  return (process.env.ENVIRONMENT || "").trim().toLowerCase() === "staging";
}

function getServiceAccountFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  const trimmed = raw.trim();

  // Normal: paste the full JSON file here.
  try {
    return JSON.parse(trimmed);
  } catch {
    // If the JSON was pasted with outer quotes, unwrap once.
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return JSON.parse(trimmed.slice(1, -1));
    }
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

async function appendRowToGoogleSheet(valuesRow) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || "Bookings";
  const sa = getServiceAccountFromEnv();

  if (!spreadsheetId) throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID");
  if (!sa?.client_email) throw new Error("Service account JSON missing client_email");
  if (!sa?.private_key) throw new Error("Service account JSON missing private_key");

  // Ensure \n sequences become actual newlines (Render often stores it escaped)
  const privateKey = String(sa.private_key).replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  // A:L = 12 columns (matches your header plan)
  // Quote sheet name to handle spaces/special characters.
  // Escape single quotes per A1 notation rules: ' becomes ''
  const safeSheetName = String(sheetName).replace(/'/g, "''");
  const range = `'${safeSheetName}'!A1`;
  console.log("[SHEETS][DEBUG] append range =", range);

  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [valuesRow] }
  });

  return resp.data?.updates?.updatedRange;
}

/**

=========================
GOOGLE MAPS: GEOCODE + DIRECTIONS
=========================
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

  try {
    console.log("[OFFICIAL] geocoding pickup...");
    const from = await geocode(pickupAddress);

    console.log("[OFFICIAL] geocoding dropoff...");
    const to = await geocode(dropoffAddress);

    console.log("[OFFICIAL] directions...");
    const r = await directions(from, to);

    // IMPORTANT: if TaxiCaller is down/slow, do NOT crash the server
    let jwt;
    try {
      jwt = await getOfficialTaxiCallerJwt();
    } catch (e) {
      console.log("[OFFICIAL] jwt error", { message: String(e?.message || e) });
      return { success: false, error: `TaxiCaller JWT error: ${String(e?.message || e)}` };
    }

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
    let text;

    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify(payload)
      });
      text = await res.text();
    } catch (e) {
      console.log("[OFFICIAL BOOKER] fetch error", {
        message: String(e?.message || e),
        code: e?.cause?.code || e?.code
      });
      return { success: false, error: `TaxiCaller booker fetch failed: ${e?.cause?.code || e?.code || e?.message || e}` };
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
  } catch (e) {
    // Catch-all so nothing here can crash the server / cause 502s
    console.log("[OFFICIAL] createBookerOrderOfficial error", { message: String(e?.message || e) });
    return { success: false, error: String(e?.message || e) };
  }
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
 * - Vapi tool-calls payload: body.message.toolCallList[0].function.arguments
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

  const pickup_address = String(input?.pickup_address || "").trim();
  const destination_address = String(input?.destination_address || "").trim();
  const customer_phone = String(input?.customer_phone || "").trim();
  const notes = input?.notes != null ? String(input.notes) : "";

  // Optional fields (won't break if missing)
  const passengers = input?.passengers ?? "";
  const customer_name = input?.customer_name != null ? String(input.customer_name) : "";
  const language = input?.language != null ? String(input.language) : "";

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

  // ---- DEBUG: confirm env + flag ----
  console.log("[SHEETS][DEBUG]", {
    ENVIRONMENT: process.env.ENVIRONMENT,
    ENABLE_GOOGLE_SHEETS_LOG: process.env.ENABLE_GOOGLE_SHEETS_LOG,
    isStagingEnv: isStagingEnv(),
    enabledBool: envBool("ENABLE_GOOGLE_SHEETS_LOG", false),
    resultSuccess: Boolean(result?.success)
  });

  // ---- STAGING ONLY: Google Sheets logging (non-fatal) ----
  try {
    const shouldLogSheets = isStagingEnv() && envBool("ENABLE_GOOGLE_SHEETS_LOG", false);

    if (shouldLogSheets && result?.success) {
      console.log("[SHEETS][DEBUG] will-append", { booking_id: result.booking_id });

      const createdAtUtc = new Date().toISOString();

      // 12 columns (A-L)
      const row = [
        createdAtUtc,                      // created_at_utc
        "Sara G5",                         // assistant (staging tests)
        "staging",                         // environment
        String(result.booking_id || ""),   // booking_id
        pickup_address,                    // pickup_address
        destination_address,               // destination_address
        customer_name,                     // customer_name
        customer_phone,                    // customer_phone (full; Sheet is internal)
        String(passengers),                // passengers
        notes,                             // notes
        String(result.eta || ""),          // eta
        JSON.stringify(
          {
            input: {
              pickup_address,
              destination_address,
              customer_name,
              customer_phone,
              passengers,
              notes,
              language
            },
            result
          },
          null,
          0
        )                                  // raw_response_json
      ];

      const updatedRange = await appendRowToGoogleSheet(row);
      console.log("[SHEETS] appended row to", updatedRange);
    } else if (shouldLogSheets) {
      console.log("[SHEETS] skipped (booking not successful)");
    }
  } catch (e) {
    console.error("[SHEETS] append failed (non-fatal):", e?.message || e);
  }

  const status = result.success ? 200 : 500;
  return sendVapiOrSimple(res, toolCallId, result, status);
});

/**
 * =========================
 * START SERVER
 * =========================
 */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

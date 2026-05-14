/**
 * server.js (ESM)
 * SAFE rollout:
 * - /create-booking stays LEGACY by default
 * - USE_OFFICIAL_BOOKER=true switches /create-booking to Official Booker API
 *
 * Probes are protected by PROBE_SECRET.
 */

import express from "express";

console.log("BOOT:", new Date().toISOString());

const app = express();

// Accept JSON + text/plain (Vapi sometimes sends JSON as text)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/*", limit: "2mb" }));

/**
 * =========================
 * ENV
 * =========================
 */
const USE_OFFICIAL_BOOKER = String(process.env.USE_OFFICIAL_BOOKER || "").toLowerCase() === "true";

// Legacy DispatchApp base (existing)
const TAXICALLER_BASE_URL = process.env.TAXICALLER_BASE_URL; // e.g. https://dn1001-rc.taxicaller.net
const TAXICALLER_DSESSION = process.env.TAXICALLER_DSESSION; // VALUE ONLY
const TAXICALLER_TCU = process.env.TAXICALLER_TCU; // "TCU ...."
const TAXICALLER_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_JWT_TTL_SECONDS || 3600);

// Official Open API (RC)
const TAXICALLER_OFFICIAL_API_BASE_URL =
  process.env.TAXICALLER_OFFICIAL_API_BASE_URL || "https://api-rc.taxicaller.net";
const TAXICALLER_API_KEY = process.env.TAXICALLER_API_KEY;
const TAXICALLER_OFFICIAL_JWT_SUBJECT = process.env.TAXICALLER_OFFICIAL_JWT_SUBJECT || "*";
const TAXICALLER_OFFICIAL_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_OFFICIAL_JWT_TTL_SECONDS || 900);
const TAXICALLER_COMPANY_ID = Number(process.env.TAXICALLER_COMPANY_ID || 0);

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * =========================
 * REQUIRE ENV
 * =========================
 */
function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function requireOfficialEnv() {
  requireEnv("TAXICALLER_API_KEY");
  if (!TAXICALLER_OFFICIAL_API_BASE_URL) throw new Error("Missing TAXICALLER_OFFICIAL_API_BASE_URL");
  requireEnv("TAXICALLER_COMPANY_ID");
}

function requireProbeSecret(req, res, next) {
  const expected = process.env.PROBE_SECRET;
  if (!expected) return res.status(500).json({ ok: false, error: "Missing env var: PROBE_SECRET" });

  const got = String(req.header("x-probe-secret") || "");
  if (got !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  return next();
}

/**
 * =========================
 * SAFE LOGGING HELPERS
 * =========================
 */
function maskPhone(s) {
  const str = String(s ?? "");
  return str.replace(/\d(?=\d{2})/g, "*");
}

function redact(s) {
  const str = String(s ?? "");
  if (!str) return "";
  if (str.length <= 12) return "***";
  return str.slice(0, 6) + "…" + str.slice(-4);
}

function safeJsonSnippet(obj, maxLen = 1500) {
  try {
    const raw = JSON.stringify(obj);
    const masked = raw.replace(/\+?\d[\d\-\s().]{7,}\d/g, (m) => maskPhone(m));
    return masked.slice(0, maxLen);
  } catch {
    return "[unstringifiable]";
  }
}

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

// Taxicaller wants [Long, Lat] multiplied by 1e6 and rounded to integers
function toE6([lon, lat]) {
  return [Math.round(lon * 1e6), Math.round(lat * 1e6)];
}

/**
 * =========================
 * GOOGLE MAPS: Geocode + Directions
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

  // Flattened E6 pts array: [lonE6, latE6, lonE6, latE6, ...]
  const pts = [];
  for (const step of leg.steps) {
    pts.push(...toE6([step.start_location.lng, step.start_location.lat]));
  }
  pts.push(...toE6([leg.end_location.lng, leg.end_location.lat]));

  return { dist, edur, pts };
}
/**
 * =========================
 * OFFICIAL JWT cache (GET /api/v1/jwt/for-key?key=...&sub=...&ttl=...)
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

  // Some environments also expose /AdminService; we try both.
  const endpointPathsToTry = ["/api/v1/jwt/for-key", "/AdminService/v1/jwt/for-key"];

  let lastErrText = null;

  for (const path of endpointPathsToTry) {
    const base = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, path);

    // Real URL (contains real key) - do NOT log this.
    const qs = new URLSearchParams({ key, sub, ttl: String(ttl) }).toString();
    const url = `${base}?${qs}`;

    // Safe URL for logs (redacted key)
    const safeQs = new URLSearchParams({ key: redact(key), sub, ttl: String(ttl) }).toString();
    const safeUrl = `${base}?${safeQs}`;

    console.log("[OFFICIAL JWT] request", { method: "GET", endpointPath: path, url: safeUrl });

    const res = await fetch(url, { method: "GET" });
    const text = await res.text();

    console.log("[OFFICIAL JWT] response", {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      bodyPreview: text.slice(0, 300),
      xRequestId: res.headers.get("x-request-id"),
      xCorrelationId: res.headers.get("x-correlation-id")
    });

    if (!res.ok) {
      lastErrText = `HTTP ${res.status}: ${text}`;
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    const token = data?.token ?? data?.data?.token ?? data?.jwt ?? data?.access_token ?? null;
    if (!token || typeof token !== "string") {
      lastErrText = `Missing token in response: ${text.slice(0, 300)}`;
      continue;
    }

    officialJwtCache.token = token;
    officialJwtCache.expiresAtMs = Date.now() + ttl * 1000;

    console.log("[OFFICIAL JWT] generated", { endpointPath: path, expiresInSeconds: ttl });

    return token;
  }

  throw new Error(`Official JWT generation failed. ${lastErrText || "Unknown error"}`);
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
 * LEGACY JWT cache (DispatchApp) + TCU session detection
 * =========================
 */
const JWT_RENEW_EARLY_SECONDS = 600;
let jwtCache = { token: null, expiresAtMs: 0 };
const ERR_TCU_NOT_LOGGED_IN = "TAXICALLER_TCU_NOT_LOGGED_IN";

async function generateTaxiCallerJwt({ sub = "*", ttlSeconds = TAXICALLER_JWT_TTL_SECONDS } = {}) {
  requireEnv("TAXICALLER_BASE_URL");
  requireEnv("TAXICALLER_TCU");

  const url = `${TAXICALLER_BASE_URL}/DispatchApp/user`;

  const payload = {
    method: "jwt",
    data: { sub, ttl: ttlSeconds },
    type: "GET"
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      authorization: TAXICALLER_TCU
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) throw new Error(`TaxiCaller JWT error ${res.status}: ${text}`);

  // Detect invalid session (can come as 200 with error payload)
  if (data?.err_msg === "Not logged in" || data?.retcode === 9568258) {
    const err = new Error(ERR_TCU_NOT_LOGGED_IN);
    err.details = { err_msg: data?.err_msg, retcode: data?.retcode };
    throw err;
  }

  const token = data?.data?.token;
  if (!token) throw new Error(`TaxiCaller JWT missing token. Response: ${text}`);

  jwtCache.token = token;
  jwtCache.expiresAtMs = Date.now() + ttlSeconds * 1000;

  console.log("[LEGACY JWT] generated", { hasToken: true, expiresInSeconds: ttlSeconds });

  return token;
}

async function getTaxiCallerJwt() {
  const now = Date.now();
  const renewAtMs = jwtCache.expiresAtMs - JWT_RENEW_EARLY_SECONDS * 1000;

  if (jwtCache.token && now < renewAtMs) return jwtCache.token;

  return await generateTaxiCallerJwt({ sub: "*", ttlSeconds: TAXICALLER_JWT_TTL_SECONDS });
}

async function refreshTaxiCallerJwt() {
  console.log("[LEGACY JWT] refreshed (forced)");
  jwtCache.token = null;
  jwtCache.expiresAtMs = 0;
  return await getTaxiCallerJwt();
}
/**
 * =========================
 * LEGACY: DispatchApp addjob (kept for production default)
 * =========================
 */
async function taxicallerAddJob({ callerPhone, from, to, route }) {
  requireEnv("TAXICALLER_BASE_URL");
  requireEnv("GOOGLE_MAPS_API_KEY");

  const url = `${TAXICALLER_BASE_URL}/DispatchApp/dispatch`;

  const payload = {
    method: "addjob",
    data: {
      job: {
        company_id: 1,
        id: 0,
        when: 0,
        when_text: "",
        state: { vehicle: "0", status: 0 },
        client: { name: "", phone: callerPhone, email: "" },
        extra: {
          info: "",
          tags: {
            passengers: "1",
            bags: "0",
            wc: "0",
            acc_extra: { cost_code: "", reference: "", project: "" },
            fare: { cat: "0" },
            ctids: [],
            cutids: [],
            vehicle_class: "",
            booked_by: "Dave Johnson",
            last_edited_by: "Dave Johnson"
          },
          src: 1,
          vtype: "0",
          payw: 10,
          pidx: "0"
        },
        route: {
          from_text: from.text,
          to_text: to.text,
          from: { lat: from.lat, lon: from.lon },
          to: { lat: to.lat, lon: to.lon },
          dist: route.dist,
          edur: route.edur,
          route_points: route.route_points
        },
        account: { rvid: 0, prio: "0" }
      },
      cars: "1",
      check_outside: false,
      check_duplicates: true,
      check_blacklist: true,
      check_driver_blocked: true,
      snapshot: false
    }
  };

  const doRequestWithJwt = async () => {
    if (!process.env.TAXICALLER_TCU) return null;

    console.log("Auth method: LEGACY JWT");
    const jwt = await getTaxiCallerJwt();

    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload)
    });
  };

  const doRequestWithDsession = async () => {
    requireEnv("TAXICALLER_DSESSION");

    console.log("Auth method: DSESSION (fallback)");
    const dsessionValue = (TAXICALLER_DSESSION || "").trim();
    if (!dsessionValue) throw new Error("Empty TAXICALLER_DSESSION");

    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `dsession=${dsessionValue}` },
      body: JSON.stringify(payload)
    });
  };

  let res;
  try {
    res = await doRequestWithJwt();
  } catch (e) {
    if (String(e?.message) === ERR_TCU_NOT_LOGGED_IN) {
      console.log("LEGACY JWT Not logged in -> fallback to dsession");
      res = await doRequestWithDsession();
    } else {
      throw e;
    }
  }

  if (!res) {
    res = await doRequestWithDsession();
  } else {
    if (res.status === 401) {
      console.log("LEGACY JWT 401 -> refresh + retry once");
      await refreshTaxiCallerJwt();

      try {
        res = await doRequestWithJwt();
      } catch (e) {
        if (String(e?.message) === ERR_TCU_NOT_LOGGED_IN) {
          console.log("LEGACY JWT Not logged in -> fallback to dsession");
          res = await doRequestWithDsession();
        } else {
          throw e;
        }
      }

      if (res.status === 401) {
        console.log("Fallback to dsession (still 401)");
        res = await doRequestWithDsession();
      }
    }
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  // Treat "Not logged in" as error even if HTTP 200
  if (data?.err_msg === "Not logged in" || data?.retcode === 9568258) {
    throw new Error(`Taxicaller auth error: ${data?.err_msg} (retcode ${data?.retcode})`);
  }

  if (!res.ok) throw new Error(`Taxicaller error ${res.status}: ${text}`);

  return data;
}

/**
 * =========================
 * OFFICIAL: Booker order payload (matches TaxiCaller documentation)
 * booking_id MUST be: response.order.order_id
 * =========================
 */
function buildOfficialBookerOrderPayload({ pickup, dropoff, customerPhone, notes = "" }) {
  const pickupCoords = toE6([pickup.lon, pickup.lat]);   // [lonE6, latE6]
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
          account: { id: 0, extra: null }, // can be null in docs; explicit is ok
          require: { seats: 1, wc: 0, bags: 0 },
          pay_info: [
            {
              "@t": 0, // CASH
              data: null
            }
          ]
        }
      ],

      route: {
        nodes: [
          {
            actions: [{ "@type": "client_action", item_seq: 0, action: "in" }],
            location: { name: pickup.text, coords: pickupCoords },
            times: { arrive: { target: 0, latest: 0 } }, // ASAP
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

async function createBookerOrderOfficial({
  pickup_address,
  destination_address,
  customer_phone,
  notes = ""
}) {
  requireOfficialEnv();
  requireEnv("GOOGLE_MAPS_API_KEY");

  const phone = String(customer_phone || "").trim().toLowerCase();
  const invalidPhones = new Set(["", "e.164", "unknown", "private", "anonymous", "blocked", "unavailable"]);
  if (invalidPhones.has(phone)) {
    return { success: false, error: "ASK_PHONE_NUMBER" };
  }

  console.log("[OFFICIAL] geocoding pickup...");
  const from = await geocode(pickup_address);

  console.log("[OFFICIAL] geocoding dropoff...");
  const to = await geocode(destination_address);

  console.log("[OFFICIAL] directions...");
  const r = await directions(from, to);

  const jwt = await getOfficialTaxiCallerJwt();

  const payload = buildOfficialBookerOrderPayload({
    pickup: from,
    dropoff: to,
    customerPhone: customer_phone,
    notes
  });

  // Inject route computed values into correct locations per doc
  payload.order.route.meta.dist = r.dist;
  payload.order.route.meta.est_dur = r.edur;

  payload.order.route.legs[0].meta.dist = r.dist;
  payload.order.route.legs[0].meta.est_dur = r.edur;

  payload.order.route.legs[0].pts = r.pts;

  const url = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, "/api/v1/booker/order");

  console.log("[OFFICIAL BOOKER] request", {
    method: "POST",
    url,
    payloadSnippet: safeJsonSnippet(payload, 2500)
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

  // Redact order_token in preview if present
  const safeTextPreview = String(text || "")
    .replace(/"order_token"\s*:\s*"([^"]+)"/, (_m, tok) => `"order_token":"${redact(tok)}"`)
    .slice(0, 800);

  console.log("[OFFICIAL BOOKER] response", {
    status: res.status,
    ok: res.ok,
    bodyPreview: safeTextPreview,
    xRequestId: res.headers.get("x-request-id"),
    xCorrelationId: res.headers.get("x-correlation-id")
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return { success: false, error: `Booker order error ${res.status}: ${String(text).slice(0, 500)}` };
  }

  const orderToken = data?.order_token ?? null;
  const bookingId = data?.order?.order_id ?? null;

  console.log("[OFFICIAL BOOKER] parsed", {
    hasOrderToken: Boolean(orderToken),
    orderTokenPreview: orderToken ? redact(orderToken) : null,
    bookingId: bookingId ? String(bookingId) : null
  });

  if (!bookingId) {
    return { success: false, error: `Missing response.order.order_id. Response preview: ${safeJsonSnippet(data, 800)}` };
  }

  return { success: true, booking_id: String(bookingId), eta: "Soon" };
}

/**
 * =========================
 * PROBES (protected by PROBE_SECRET)
 * =========================
 * Use these to validate Official JWT + Booker payload without touching production flow.
 */

// Official JWT check (GET)
app.get("/taxicaller/official-jwt-check", requireProbeSecret, async (req, res) => {
  try {
    const token = await getOfficialTaxiCallerJwt();
    res.json({
      ok: true,
      hasToken: Boolean(token),
      tokenPreview: token ? redact(token) : null,
      expiresAtMs: officialJwtCache.expiresAtMs
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Booker order probe (POST). You provide full payload { order: {...} }.
app.post("/taxicaller/booker/order-probe", requireProbeSecret, async (req, res) => {
  try {
    requireOfficialEnv();

    const jwt = await getOfficialTaxiCallerJwt();
    const url = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, "/api/v1/booker/order");

    let body = req.body;
    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }
    const payload = body && typeof body === "object" ? body : {};

    console.log("[PROBE booker/order] request", {
      url,
      method: "POST",
      payloadSnippet: safeJsonSnippet(payload, 2500)
    });

    const tcRes = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify(payload)
    });

    const text = await tcRes.text();

    // Redact order_token in response preview/logs
    const safeTextPreview = String(text || "")
      .replace(/"order_token"\s*:\s*"([^"]+)"/, (_m, tok) => `"order_token":"${redact(tok)}"`)
      .slice(0, 800);

    console.log("[PROBE booker/order] response", {
      status: tcRes.status,
      ok: tcRes.ok,
      bodyPreview: safeTextPreview,
      xRequestId: tcRes.headers.get("x-request-id"),
      xCorrelationId: tcRes.headers.get("x-correlation-id")
    });

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    // Also redact token in JSON response if present
    if (parsed?.order_token) parsed.order_token = redact(parsed.order_token);

    return res.status(200).json({
      ok: tcRes.ok,
      status: tcRes.status,
      responseTextPreview: safeTextPreview,
      responseJson: parsed
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * =========================
 * HEALTH
 * =========================
 */
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/routes-check", (req, res) =>
  res.json({
    ok: true,
    hasCreateBooking: true,
    bookingMode: USE_OFFICIAL_BOOKER ? "official" : "legacy"
  })
);

/**
 * =========================
 * MAIN ENDPOINT: /create-booking
 * =========================
 * Default: legacy addjob.
 * If USE_OFFICIAL_BOOKER=true: official booker/order.
 *
 * Accepts either:
 * - Direct JSON: { pickup_address, destination_address, customer_phone, notes? }
 * - Vapi tool-calls payload: body.message.toolCallList[0].function.arguments
 *
 * Returns either:
 * - Simple JSON
 * - or Vapi format: { results: [{ toolCallId, result }] }
 */
app.post("/create-booking", async (req, res) => {
  console.log(`BOOKING MODE: ${USE_OFFICIAL_BOOKER ? "official" : "legacy"}`);

  const sendSimple = (payload, status = 200) => res.status(status).json(payload);
  const sendVapi = (toolCallId, result, status = 200) =>
    res.status(status).json({ results: [{ toolCallId, result }] });

  const getToolCallIdIfAny = (body) => {
    if (!body) return null;
    if (typeof body === "object") return body?.message?.toolCallList?.[0]?.id || null;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        return parsed?.message?.toolCallList?.[0]?.id || null;
      } catch {
        return null;
      }
    }
    return null;
  };

  try {
    // Parse body
    let body = req.body;
    const toolCallId = getToolCallIdIfAny(body);

    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    // Extract Vapi tool args if present
    const vapiArgsRaw = body?.message?.toolCallList?.[0]?.function?.arguments;
    let vapiArgs = {};
    if (typeof vapiArgsRaw === "string") vapiArgs = vapiArgsRaw.trim() ? JSON.parse(vapiArgsRaw) : {};
    else if (vapiArgsRaw && typeof vapiArgsRaw === "object") vapiArgs = vapiArgsRaw;

    const callerPhone = body.customer_phone ?? vapiArgs.customer_phone ?? "";
    const pickupAddress = body.pickup_address ?? vapiArgs.pickup_address ?? "";
    const dropoffAddress = body.destination_address ?? vapiArgs.destination_address ?? "";
    const notes = String(body.notes ?? vapiArgs.notes ?? "");

    console.log("create-booking args:", {
      callerPhone: maskPhone(callerPhone),
      pickupAddress,
      dropoffAddress,
      notes
    });

    if (!pickupAddress || !dropoffAddress) {
      const out = { success: false, error: "Missing pickup_address or destination_address" };
      return toolCallId ? sendVapi(toolCallId, out, 400) : sendSimple(out, 400);
    }

    // OFFICIAL path
    if (USE_OFFICIAL_BOOKER) {
      const result = await createBookerOrderOfficial({
        pickup_address: pickupAddress,
        destination_address: dropoffAddress,
        customer_phone: callerPhone,
        notes
      });

      const status = result.success ? 200 : 500;
      return toolCallId ? sendVapi(toolCallId, result, status) : sendSimple(result, status);
    }

    // LEGACY path (default)
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("GOOGLE_MAPS_API_KEY");

    const phoneRaw = String(callerPhone || "").trim().toLowerCase();
    const invalidPhones = new Set(["", "e.164", "unknown", "private", "anonymous", "blocked", "unavailable"]);
    if (invalidPhones.has(phoneRaw)) {
      const out = { success: false, error: "ASK_PHONE_NUMBER" };
      return toolCallId ? sendVapi(toolCallId, out, 400) : sendSimple(out, 400);
    }

    console.log("[LEGACY] geocoding pickup...");
    const from = await geocode(pickupAddress);

    console.log("[LEGACY] geocoding dropoff...");
    const to = await geocode(dropoffAddress);

    // Keep legacy route_points empty unless you want to restore your legacy route_points logic
    const route = { dist: 0, edur: 0, route_points: [] };

    console.log("[LEGACY] sending addjob...");
    const tc = await taxicallerAddJob({ callerPhone, from, to, route });

    const booking_id = tc?.data?.job?.id ?? tc?.jobId ?? tc?.job_id ?? tc?.id ?? null;
    const etaRaw = tc?.data?.job?.eta_text ?? tc?.eta ?? null;
    const eta = etaRaw ?? "Soon";

    const out = {
      success: true,
      eta,
      booking_id: booking_id ? String(booking_id) : null
    };

    return toolCallId ? sendVapi(toolCallId, out) : sendSimple(out);
  } catch (err) {
    console.log("ERROR /create-booking:", err);

    const msg = String(err?.message || err);
    const toolCallId = getToolCallIdIfAny(req.body);

    const out = { success: false, error: msg };
    return toolCallId ? sendVapi(toolCallId, out, 500) : sendSimple(out, 500);
  }
});

/**
 * =========================
 * START SERVER
 * =========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

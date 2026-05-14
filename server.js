/**
 * server.js (ESM)
 * Safe architecture:
 * Vapi -> POST /create-booking -> Render -> TaxiCaller
 *
 * Default: LEGACY (DispatchApp addjob)
 * Feature flag: USE_OFFICIAL_BOOKER=true  => Official Booker API (/api/v1/booker/order)
 *
 * Part 1/3: base server, env, helpers, maps, JWTs (legacy + official)
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

// Legacy DispatchApp base (your existing)
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

/**
 * Probe secret middleware
 */
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

  // Flattened E6 pts: [lonE6, latE6, lonE6, latE6, ...]
  const pts = [];
  for (const step of leg.steps) {
    pts.push(...toE6([step.start_location.lng, step.start_location.lat]));
  }
  pts.push(...toE6([leg.end_location.lng, leg.end_location.lat]));

  return { dist, edur, pts };
}

/**
 * =========================
 * OFFICIAL JWT cache
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

  // Try both RC endpoints; log url + method + status to confirm.
  const endpointPathsToTry = ["/api/v1/jwt/for-key", "/AdminService/v1/jwt/for-key"];

  let lastErrText = null;

  for (const path of endpointPathsToTry) {
    const url = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, path);

    console.log("[OFFICIAL JWT] request", {
      method: "POST",
      url,
      endpointPath: path,
      sub,
      ttl,
      apiKeyPreview: redact(TAXICALLER_API_KEY)
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        key: TAXICALLER_API_KEY,
        sub,
        ttl
      })
    });

    const text = await res.text();

    console.log("[OFFICIAL JWT] response", {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type"),
      bodyPreview: text.slice(0, 300)
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
 * LEGACY JWT cache (DispatchApp)
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
 * LEGACY: DispatchApp addjob (kept as-is conceptually)
 * =========================
 * Uses legacy auth: JWT via TCU, fallback to dsession.
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

  if (data?.err_msg === "Not logged in" || data?.retcode === 9568258) {
    throw new Error(`Taxicaller auth error: ${data?.err_msg} (retcode ${data?.retcode})`);
  }
  if (!res.ok) throw new Error(`Taxicaller error ${res.status}: ${text}`);

  return data;
}

/**
 * =========================
 * OFFICIAL: Booker order payload builder
 * =========================
 * This is a BASE template. TaxiCaller may require additional fields.
 * Use /taxicaller/booker/order-probe with Johan's "Example Value" to perfect it.
 */
function buildBookerOrderPayloadBase({ pickup, dropoff, customerPhone, notes = "" }) {
  const company_id = TAXICALLER_COMPANY_ID;

  const passenger = {
    name: "Caller",
    email: "",
    phone: customerPhone
  };

  const requireObj = {
    seats: 1,
    wc: 0,
    bags: 0
  };

  const pickupCoords = toE6([pickup.lon, pickup.lat]);
  const dropoffCoords = toE6([dropoff.lon, dropoff.lat]);

  return {
    company_id,

    // Often required fields (depends on docs)
    provider_id: 0,
    client_id: 0,

    times: {
      arrive: { target: 0 } // ASAP
    },

    items: [
      {
        "@type": "passengers",
        seq: 0,
        passenger,
        require: requireObj,
        notes: String(notes || "")
      }
    ],

    route: {
      nodes: [
        { "@type": "pickup", seq: 0, text: pickup.text, coords: pickupCoords },
        { "@type": "dropoff", seq: 1, text: dropoff.text, coords: dropoffCoords }
      ],
      legs: [
        {
          seq: 0,
          pts: [] // fill from directions
        }
      ],
      meta: {
        dist: 0,
        est_dur: 0
      }
    },

    pay_info: {
      method: "cash"
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

  const payload = buildBookerOrderPayloadBase({
    pickup: from,
    dropoff: to,
    customerPhone: customer_phone,
    notes
  });

  // Inject route computed values
  payload.route.meta.dist = r.dist;
  payload.route.meta.est_dur = r.edur;
  payload.route.legs[0].pts = r.pts;

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

  console.log("[OFFICIAL BOOKER] response", {
    status: res.status,
    ok: res.ok,
    bodyPreview: text.slice(0, 800),
    xRequestId: res.headers.get("x-request-id"),
    xCorrelationId: res.headers.get("x-correlation-id")
  });

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return { success: false, error: `Booker order error ${res.status}: ${text.slice(0, 500)}` };
  }

  // Extract booking id/eta (adjust once you see real response from TaxiCaller)
  const booking_id = data?.id ?? data?.data?.id ?? data?.order_id ?? data?.orderId ?? null;
  const eta = data?.eta ?? data?.data?.eta ?? null;

  return {
    success: true,
    booking_id: booking_id ? String(booking_id) : null,
    eta: eta ?? "Soon",
    raw: data
  };
}

/**
 * =========================
 * PROBES (protected by PROBE_SECRET)
 * =========================
 */
app.get("/taxicaller/official-jwt-check", requireProbeSecret, async (req, res) => {
  try {
    const token = await getOfficialTaxiCallerJwt();
    res.json({ ok: true, hasToken: Boolean(token), expiresAtMs: officialJwtCache.expiresAtMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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

    console.log("[PROBE booker/order] response", {
      status: tcRes.status,
      ok: tcRes.ok,
      bodyPreview: text.slice(0, 800),
      xRequestId: tcRes.headers.get("x-request-id"),
      xCorrelationId: tcRes.headers.get("x-correlation-id")
    });

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}

    return res.status(200).json({
      ok: tcRes.ok,
      status: tcRes.status,
      responseText: text,
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
app.get("/routes-check", (req, res) => res.json({ ok: true, hasCreateBooking: true }));

/**
 * =========================
 * MAIN ENDPOINT: /create-booking
 * =========================
 * - Accepts either direct JSON or Vapi tool-calls payload
 * - Returns either simple JSON or { results: [{ toolCallId, result }]}
 * - Default: legacy addjob
 * - Feature flag: USE_OFFICIAL_BOOKER=true => official booker/order
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
    // 1) Parse body
    let body = req.body;
    const toolCallId = getToolCallIdIfAny(body);

    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    // 2) Extract Vapi tool args (if present)
    const vapiArgsRaw = body?.message?.toolCallList?.[0]?.function?.arguments;
    let vapiArgs = {};
    if (typeof vapiArgsRaw === "string") vapiArgs = vapiArgsRaw.trim() ? JSON.parse(vapiArgsRaw) : {};
    else if (vapiArgsRaw && typeof vapiArgsRaw === "object") vapiArgs = vapiArgsRaw;

    // 3) Support both direct + vapi args
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

    // 4) Common validation
    if (!pickupAddress || !dropoffAddress) {
      const out = { success: false, error: "Missing pickup_address or destination_address" };
      return toolCallId ? sendVapi(toolCallId, out, 400) : sendSimple(out, 400);
    }

    // 5) OFFICIAL path
    if (USE_OFFICIAL_BOOKER) {
      const result = await createBookerOrderOfficial({
        pickup_address: pickupAddress,
        destination_address: dropoffAddress,
        customer_phone: callerPhone,
        notes
      });

      // Keep response shape stable for Vapi
      const status = result.success ? 200 : 500;
      return toolCallId ? sendVapi(toolCallId, result, status) : sendSimple(result, status);
    }

    // 6) LEGACY path
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

    // Legacy addjob expects dist/edur/route_points
    // We keep route_points empty here (legacy API usually tolerates it),
    // but you can swap back to your original directions() if you want route_points.
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

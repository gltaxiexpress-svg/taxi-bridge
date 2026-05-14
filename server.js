import express from "express";

console.log("BOOT MARKER:", "routes-check-enabled", new Date().toISOString());

const app = express();

// Accept text/plain bodies (Vapi/Taxicaller often send JSON as text)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/*", limit: "2mb" }));

const TAXICALLER_BASE_URL = process.env.TAXICALLER_BASE_URL; // https://dn1001-rc.taxicaller.net
const TAXICALLER_DSESSION = process.env.TAXICALLER_DSESSION; // VALUE ONLY (not "dsession=")
const TAXICALLER_TCU = process.env.TAXICALLER_TCU; // "TCU ...."
const TAXICALLER_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_JWT_TTL_SECONDS || 3600);

// ✅ OFFICIAL TaxiCaller Open API auth (RC)
const TAXICALLER_API_KEY = process.env.TAXICALLER_API_KEY; // generated at https://app-rc.taxicaller.net/dispatch/api/keys
const TAXICALLER_OFFICIAL_API_BASE_URL =
  process.env.TAXICALLER_OFFICIAL_API_BASE_URL || "https://api-rc.taxicaller.net";
const TAXICALLER_OFFICIAL_JWT_TTL_SECONDS = Number(process.env.TAXICALLER_OFFICIAL_JWT_TTL_SECONDS || 900);
// ✅ subject for official JWT (set in Render)
const TAXICALLER_OFFICIAL_JWT_SUBJECT = process.env.TAXICALLER_OFFICIAL_JWT_SUBJECT || "*";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function requireProbeSecret(req, res, next) {
  const expected = process.env.PROBE_SECRET;

  // Misconfig protection: if you forgot to set it in Render
  if (!expected) {
    return res.status(500).json({ ok: false, error: "Missing env var: PROBE_SECRET" });
  }

  const got = String(req.header("x-probe-secret") || "");
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

/**
 * =========================
 * SAFE LOGGING HELPERS
 * =========================
 * We avoid logging sensitive data (phones, tokens, headers).
 */
function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function redact(s) {
  const str = String(s ?? "");
  if (str.length <= 12) return "***";
  return str.slice(0, 6) + "…" + str.slice(-4);
}
function maskPhone(s) {
  const str = String(s ?? "");
  // mask digits leaving only last 2 digits visible
  return str.replace(/\d(?=\d{2})/g, "*");
}

function safeJsonSnippet(obj, maxLen = 1500) {
  try {
    const raw = JSON.stringify(obj);
    // mask phone-like patterns (best effort)
    const masked = raw.replace(/\+?\d[\d\-\s().]{7,}\d/g, (m) => maskPhone(m));
    return masked.slice(0, maxLen);
  } catch {
    return "[unstringifiable]";
  }
}

/**
 * =========================
 * TaxiCaller OFFICIAL API JWT cache
 * =========================
 */
const OFFICIAL_JWT_RENEW_EARLY_SECONDS = 120; // renew 2 minutes before expiry
let officialJwtCache = {
  token: null,
  expiresAtMs: 0
};

function requireOfficialEnv() {
  if (!TAXICALLER_API_KEY) throw new Error("Missing env var: TAXICALLER_API_KEY");
}

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

  const endpointPathsToTry = [
    "/api/v1/jwt/for-key",
    "/AdminService/v1/jwt/for-key"
  ];

  let lastErrText = null;

  for (const path of endpointPathsToTry) {
    const url = joinUrl(TAXICALLER_OFFICIAL_API_BASE_URL, path);

    // IMPORTANTE: No loguear la key completa
    const key = String(TAXICALLER_API_KEY || "").trim();

    // ---- LOG REQUEST (TEMP) ----
    console.log("[OFFICIAL JWT] request", {
      method: "POST",
      endpointPath: path,
      url,
      base: TAXICALLER_OFFICIAL_API_BASE_URL,
      hasApiKey: Boolean(key),
      apiKeyPreview: redact(key),
      sub,
      ttl
    });

    // AJUSTA el body a lo que diga Johan/documentación.
    // Yo lo dejo en formato típico: { key, sub, ttl }
    const body = { key, sub, ttl };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });

    const text = await res.text();

    // ---- LOG RESPONSE (TEMP) ----
    console.log("[OFFICIAL JWT] response", {
      method: "POST",
      endpointPath: path,
      url,
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

    const now = Date.now();
    officialJwtCache.token = token;
    officialJwtCache.expiresAtMs = now + ttl * 1000;

    console.log("[OFFICIAL JWT] generated", {
      endpointPath: path,
      expiresInSeconds: ttl
    });

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
 * TaxiCaller JWT cache layer (legacy DispatchApp)
 * =========================
 * We cache the JWT in-memory and renew it before expiry.
 */
const JWT_RENEW_EARLY_SECONDS = 600; // renew 10 minutes before expiry
let jwtCache = {
  token: null,
  expiresAtMs: 0
};

// Sentinel error for "TCU not logged in"
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

  if (!res.ok) {
    throw new Error(`TaxiCaller JWT error ${res.status}: ${text}`);
  }

  // ✅ Detect TCU session invalid (Not logged in)
  if (data?.err_msg === "Not logged in" || data?.retcode === 9568258) {
    const err = new Error(ERR_TCU_NOT_LOGGED_IN);
    err.details = { err_msg: data?.err_msg, retcode: data?.retcode };
    throw err;
  }

  const token = data?.data?.token;
  if (!token) {
    throw new Error(`TaxiCaller JWT missing token. Response: ${text}`);
  }

  const now = Date.now();
  jwtCache.token = token;
  jwtCache.expiresAtMs = now + ttlSeconds * 1000;

  // SAFE LOG (no full token)
  console.log("JWT generated", {
    hasToken: true,
    sub: data?.data?.sub ?? sub,
    expiresInSeconds: ttlSeconds
  });

  return token;
}

async function getTaxiCallerJwt() {
  const now = Date.now();
  const renewAtMs = jwtCache.expiresAtMs - JWT_RENEW_EARLY_SECONDS * 1000;

  if (jwtCache.token && now < renewAtMs) return jwtCache.token;

  return await generateTaxiCallerJwt({ sub: "*", ttlSeconds: TAXICALLER_JWT_TTL_SECONDS });
}

async function refreshTaxiCallerJwt() {
  console.log("JWT refreshed (forced)");
  jwtCache.token = null;
  jwtCache.expiresAtMs = 0;
  return await getTaxiCallerJwt();
}

async function geocode(address) {
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

  const route_points = [];
  for (const step of leg.steps) {
    route_points.push(step.start_location.lat, step.start_location.lng);
  }
  route_points.push(leg.end_location.lat, leg.end_location.lng);

  return { dist, edur, route_points };
}

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
    // If TAXICALLER_TCU isn't configured, skip JWT path.
    if (!process.env.TAXICALLER_TCU) return null;

    console.log("Auth method: JWT");
    const jwt = await getTaxiCallerJwt();

    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`
      },
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
      headers: {
        "content-type": "application/json",
        cookie: `dsession=${dsessionValue}`
      },
      body: JSON.stringify(payload)
    });
  };

  // 1) Try JWT first (preferred)
  let res;
  try {
    res = await doRequestWithJwt();
  } catch (e) {
    if (String(e?.message) === ERR_TCU_NOT_LOGGED_IN) {
      console.log("JWT generation failed: Not logged in -> fallback to dsession");
      res = await doRequestWithDsession();
    } else {
      throw e;
    }
  }

  // If JWT path is unavailable, use dsession directly
  if (!res) {
    res = await doRequestWithDsession();
  } else {
    // If we got 401 with JWT: refresh + retry once
    if (res.status === 401) {
      console.log("JWT retry after 401 (refresh + retry once)");
      await refreshTaxiCallerJwt();

      try {
        res = await doRequestWithJwt();
      } catch (e) {
        if (String(e?.message) === ERR_TCU_NOT_LOGGED_IN) {
          console.log("JWT generation failed: Not logged in -> fallback to dsession");
          res = await doRequestWithDsession();
        } else {
          throw e;
        }
      }

      // If still 401, fallback to dsession (keeps service running)
      if (res.status === 401) {
        console.log("Fallback to dsession (JWT still 401 after retry)");
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

  // ✅ IMPORTANT: Treat "Not logged in" as a real error even if HTTP is 200
  if (data?.err_msg === "Not logged in" || data?.retcode === 9568258) {
    throw new Error(`Taxicaller auth error: ${data?.err_msg} (retcode ${data?.retcode})`);
  }

  if (!res.ok) {
    throw new Error(`Taxicaller error ${res.status}: ${text}`);
  }

  return data;
}

// Health check
app.get("/routes-check", (req, res) => {
  res.json({ ok: true, hasCreateBooking: true });
});
app.get("/", (req, res) => res.status(200).send("ok"));

// ✅ TEMP endpoint to test OFFICIAL JWT only (doesn't affect Vapi flow)
// Remove later if you want.
app.get("/taxicaller/official-jwt-check", async (req, res) => {
  try {
    const token = await getOfficialTaxiCallerJwt();
    res.json({ ok: true, hasToken: Boolean(token), expiresAtMs: officialJwtCache.expiresAtMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ ADDED: Probe endpoint to discover TaxiCaller booker/order schema (RC)
app.post("/taxicaller/booker/order-probe", requireProbeSecret, async (req, res) => {
  try {
    const jwt = await getOfficialTaxiCallerJwt();
    const url = `${TAXICALLER_OFFICIAL_API_BASE_URL}/api/v1/booker/order`;

    let body = req.body;
    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    const payload = body && typeof body === "object" ? body : {};

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
// ✅ TEMP: Probe booker-token (TaxiCaller Official API / Booker API)
// Does NOT affect Vapi flow.
// Returns raw response so we can discover requirements for Booker API.
app.get("/taxicaller/booker/token-probe", requireProbeSecret, async (req, res) => {
  try {
    const jwt = await getOfficialTaxiCallerJwt();
    const url = `${TAXICALLER_OFFICIAL_API_BASE_URL}/api/v1/booker/booker-token`;

    const tcRes = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      }
    });

    // ✅ SAFE LOG: no JWT, only status + useful correlation headers
    console.log("booker-token probe", {
      status: tcRes.status,
      contentType: tcRes.headers.get("content-type"),
      xRequestId: tcRes.headers.get("x-request-id"),
      xCorrelationId: tcRes.headers.get("x-correlation-id"),
      date: tcRes.headers.get("date")
    });

    const text = await tcRes.text();

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
// ✅ TEMP: Probe booker-token using POST (in case GET is not supported in RC)
app.post("/taxicaller/booker/token-probe-post", requireProbeSecret, async (req, res) => {
  try {
    const jwt = await getOfficialTaxiCallerJwt();
    const url = `${TAXICALLER_OFFICIAL_API_BASE_URL}/api/v1/booker/booker-token`;

    const tcRes = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${jwt}`
      },
      body: "{}"
    });

    console.log("booker-token probe POST", {
      status: tcRes.status,
      contentType: tcRes.headers.get("content-type"),
      xRequestId: tcRes.headers.get("x-request-id"),
      xCorrelationId: tcRes.headers.get("x-correlation-id"),
      date: tcRes.headers.get("date")
    });

    const text = await tcRes.text();

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
app.post("/create-booking", async (req, res) => {
  // 🔎 TRACE LOGS (para ver exactamente dónde se queda)
  console.log("HIT /create-booking", new Date().toISOString());
  console.log("RAW BODY TYPE:", typeof req.body);

  const sendSimple = (payload, status = 200) => res.status(status).json(payload);
  const sendVapi = (toolCallId, result, status = 200) =>
    res.status(status).json({ results: [{ toolCallId, result }] });

  // Detecta si viene de Vapi tool-calls (para responder con results[])
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
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("GOOGLE_MAPS_API_KEY");

    // 1) Parse body
    let body = req.body;
    const toolCallId = getToolCallIdIfAny(body);

    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    // Log where caller id might be (debug)
    console.log("VAPI customer.number:", body?.customer?.number);
    console.log("VAPI call.customer.number:", body?.call?.customer?.number);

    // 2) Acepta payload normal o payload Vapi (arguments)
    const vapiArgsRaw = body?.message?.toolCallList?.[0]?.function?.arguments;
    let vapiArgs = {};
    if (typeof vapiArgsRaw === "string") vapiArgs = vapiArgsRaw.trim() ? JSON.parse(vapiArgsRaw) : {};
    else if (vapiArgsRaw && typeof vapiArgsRaw === "object") vapiArgs = vapiArgsRaw;

    const customer_name = body.customer_name ?? vapiArgs.customer_name ?? "";
    const callerPhone = body.customer_phone ?? vapiArgs.customer_phone ?? "";
    const pickupAddress = body.pickup_address ?? vapiArgs.pickup_address ?? "";
    const dropoffAddress = body.destination_address ?? vapiArgs.destination_address ?? "";
    const passengers = Number(body.passengers ?? vapiArgs.passengers ?? 1);
    const notes = String(body.notes ?? vapiArgs.notes ?? "");

    // safer: mask phone in logs
    console.log("create-booking args:", {
      customer_name,
      callerPhone: maskPhone(callerPhone),
      pickupAddress,
      dropoffAddress,
      passengers,
      notes
    });

    // ✅ UPDATED VALIDATION (kept as-is for now)
    const phoneRaw = String(callerPhone || "").trim().toLowerCase();
    const invalidPhones = new Set(["", "e.164", "unknown", "private", "anonymous", "blocked", "unavailable"]);

    if (!pickupAddress || !dropoffAddress) {
      const out = { success: false, error: "Missing pickup_address or destination_address" };
      return toolCallId ? sendVapi(toolCallId, out, 400) : sendSimple(out, 400);
    }

    if (invalidPhones.has(phoneRaw)) {
      const out = { success: false, error: "ASK_PHONE_NUMBER" };
      return toolCallId ? sendVapi(toolCallId, out, 400) : sendSimple(out, 400);
    }

    // 3) Reutiliza tu lógica existente
    console.log("geocoding pickup...");
    const from = await geocode(pickupAddress);
    console.log("pickup geocoded:", from);

    console.log("geocoding dropoff...");
    const to = await geocode(dropoffAddress);
    console.log("dropoff geocoded:", to);

    console.log("getting directions...");
    const route = await directions(from, to);
    console.log("directions ok:", {
      dist: route.dist,
      edur: route.edur,
      points: route.route_points?.length
    });

    console.log("sending to taxicaller...");
    const tc = await taxicallerAddJob({ callerPhone, from, to, route });
    console.log("taxicaller response received");

    // Booking ID & ETA rules
    const booking_id = tc?.data?.job?.id ?? tc?.jobId ?? tc?.job_id ?? tc?.id ?? null;

    const etaRaw = tc?.data?.job?.eta_text ?? tc?.eta ?? null;
    const eta = etaRaw ?? "Soon";

    if (!booking_id) {
      // Render-only safe debug log
      console.log("WARN: BOOKING_ID_NOT_FOUND", {
        retcode: tc?.retcode,
        topKeys: tc && typeof tc === "object" ? Object.keys(tc) : [],
        dataKeys: tc?.data && typeof tc.data === "object" ? Object.keys(tc.data) : [],
        snippet: safeJsonSnippet(tc, 1500)
      });

      // Do NOT fail user experience
      const out = {
        success: true,
        eta,
        booking_id: null,
        warning: "BOOKING_ID_NOT_FOUND"
      };
      return toolCallId ? sendVapi(toolCallId, out) : sendSimple(out);
    }

    const out = {
      success: true,
      eta,
      booking_id: String(booking_id)
    };

    return toolCallId ? sendVapi(toolCallId, out) : sendSimple(out);
  } catch (err) {
    console.log("ERROR /create-booking:", err);

    // ✅ If TaxiCaller auth is broken, tell Vapi to transfer
    const msg = String(err?.message || err);
    if (msg.includes("Taxicaller auth error: Not logged in") || msg.includes("(retcode 9568258)")) {
      const out = { success: false, error: "DISPATCHER_TRANSFER" };
      const toolCallId = getToolCallIdIfAny(req.body);
      return toolCallId ? sendVapi(toolCallId, out, 500) : sendSimple(out, 500);
    }

    const out = { success: false, error: msg };
    const toolCallId = getToolCallIdIfAny(req.body);
    return toolCallId ? sendVapi(toolCallId, out, 500) : sendSimple(out, 500);
  }
});

// Vapi tool endpoint (simple JSON)
app.post("/vapi/book-taxi", async (req, res) => {
  const respond = (toolCallId, result) =>
    res.status(200).json({ results: [{ toolCallId, result }] });

  try {
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("GOOGLE_MAPS_API_KEY");

    // 1) Body parse seguro
    let body = req.body;
    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    // ... tu código igual ...
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// (optional) self-check on boot:
// set TAXICALLER_OFFICIAL_JWT_BOOT_CHECK=true to enable
if (process.env.TAXICALLER_OFFICIAL_JWT_BOOT_CHECK === "true") {
  getOfficialTaxiCallerJwt().catch((e) =>
    console.log("OFFICIAL JWT boot check failed:", e?.message || e)
  );
}

// ✅ ESTO VA AL FINAL DEL ARCHIVO (fuera de cualquier endpoint)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

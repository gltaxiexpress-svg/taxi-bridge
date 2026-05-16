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

// Google Sheets (staging logging)
const ENABLE_GOOGLE_SHEETS_LOG =
  String(process.env.ENABLE_GOOGLE_SHEETS_LOG || "").toLowerCase() === "true";

const GOOGLE_SERVICE_ACCOUNT_JSON =
  String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "");

const GOOGLE_SHEETS_SPREADSHEET_ID =
  String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "");

const GOOGLE_SHEETS_SHEET_NAME =
  String(process.env.GOOGLE_SHEETS_SHEET_NAME || "Bookings");

// TaxiCaller Official API (RC by default for staging)
const TAXICALLER_OFFICIAL_API_BASE_URL = String(
  process.env.TAXICALLER_OFFICIAL_API_BASE_URL || "https://api-rc.taxicaller.net"
);

const TAXICALLER_API_KEY = String(process.env.TAXICALLER_API_KEY || "");
const TAXICALLER_COMPANY_ID = Number(process.env.TAXICALLER_COMPANY_ID || 0);

const TAXICALLER_OFFICIAL_JWT_SUBJECT =
  String(process.env.TAXICALLER_OFFICIAL_JWT_SUBJECT || "*");

const TAXICALLER_OFFICIAL_JWT_TTL_SECONDS =
  Number(process.env.TAXICALLER_OFFICIAL_JWT_TTL_SECONDS || 900);

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

    const masked = raw.replace(/\+?\d[\d\-\s().]{7,}\d/g, (m) =>
      maskPhone(m)
    );

    return masked.length > maxLen
      ? masked.slice(0, maxLen) + "…"
      : masked;
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
  if (
    req.body &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  const raw =
    typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body || "");

  if (!raw) return {};

  // Diagnostic: shows what the server actually receives
  console.log("[parseBodyOnce] rawHead", {
    len: raw.length,
    head: raw.slice(0, 80),
    codes: Array.from(raw.slice(0, 24)).map((c) =>
      c.charCodeAt(0)
    )
  });

  // Remove BOM + leading control characters
  const cleanedPrefix = raw
    .replace(/^\uFEFF/, "")
    .replace(/^[\u0000-\u001F]+/, "");

  // Find first JSON object start
  const i = cleanedPrefix.indexOf("{");

  if (i === -1) {
    throw new Error("Body does not contain JSON object");
  }

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

  if (argsRaw && typeof argsRaw === "object") {
    args = argsRaw;
  } else if (typeof argsRaw === "string") {
    const cleaned = argsRaw.replace(/^\uFEFF/, "").trim();

    if (cleaned) {
      args = JSON.parse(cleaned);
    }
  }

  return { toolCallId, args };
}

function sendVapiOrSimple(res, toolCallId, payload, status = 200) {
  if (toolCallId) {
    return res
      .status(status)
      .json({ results: [{ toolCallId, result: payload }] });
  }

  return res.status(status).json(payload);
}

function requireProbeSecret(req, res, next) {
  if (!PROBE_SECRET) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing env var: PROBE_SECRET" });
  }

  const got = String(req.header("x-probe-secret") || "");

  if (got !== PROBE_SECRET) {
    return res
      .status(401)
      .json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

// =========================
// fetchWithTimeout (stability)
// =========================

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
  // renew 60s early
  if (
    googleSheetsTokenCache.token &&
    now < googleSheetsTokenCache.expiresAtMs - 60_000
  ) {
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
  const signature = createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(privateKey);

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
    throw new Error(
      `Google OAuth token error ${tokenRes.status}: ${tokenText.slice(0, 240)}`
    );
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

  // Non-fatal guardrails
  if (!GOOGLE_SHEETS_SPREADSHEET_ID) {
    console.log("[SHEETS] disabled/misconfigured", {
      reason: "Missing GOOGLE_SHEETS_SPREADSHEET_ID"
    });
    return;
  }

  try {
    const token = await getGoogleAccessToken();
    if (!token) return;

    // A:K matches your 11 columns
    const range = `${GOOGLE_SHEETS_SHEET_NAME}!A:K`;

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/` +
      `${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}/values/` +
      `${encodeURIComponent(range)}:append?` +
      `valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const values = [
      [
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
      ]
    ];

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
      console.log("[SHEETS] append failed", {
        status: resp.status,
        bodyPreview: respText.slice(0, 240)
      });
      return;
    }

    console.log("[SHEETS] appended", { ok: true });
  } catch (e) {
    console.log("[SHEETS] append error (non-fatal)", {
      message: asErrorMessage(e)
    });
  }
}
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

  // Manual Review logging fields
  const created_at = new Date().toISOString();
  const source = "vapi";
  const appointment_time = String(input?.appointment_time || "").trim(); // optional (blank ok)

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

      // Google Sheets (non-fatal, fire-and-forget)
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
        clientPayload,
        isUpstream ? 503 : 500
      );
    }

    // Google Sheets (non-fatal, fire-and-forget)
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

    // Google Sheets (non-fatal, fire-and-forget)
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
      clientPayload,
      isUpstream ? 503 : 500
    );
  }
});
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

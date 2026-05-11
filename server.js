  import express from "express";

const app = express();

// Accept text/plain bodies (Vapi/Taxicaller often send JSON as text)
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

const TAXICALLER_BASE_URL = process.env.TAXICALLER_BASE_URL; // https://dn1001-rc.taxicaller.net
const TAXICALLER_DSESSION = process.env.TAXICALLER_DSESSION; // VALUE ONLY (not "dsession=")
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
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
  requireEnv("TAXICALLER_DSESSION");

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

  const dsessionValue = (TAXICALLER_DSESSION || "").trim();
  if (!dsessionValue) throw new Error("Empty TAXICALLER_DSESSION");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `dsession=${dsessionValue}`
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
    throw new Error(`Taxicaller error ${res.status}: ${text}`);
  }

  return data;
}

// Health check
app.get("/", (req, res) => res.status(200).send("ok"));

// Vapi tool endpoint (simple JSON)
app.post("/vapi/book-taxi", async (req, res) => {
  try {
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("TAXICALLER_DSESSION");
    requireEnv("GOOGLE_MAPS_API_KEY");

    // Parse body even if it came as text/plain
    let body = req.body;
    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    const msg = body?.message;
    const toolCall = msg?.toolCallList?.[0];
    const toolCallId = toolCall?.id;

    if (!toolCallId) {
      return res.status(400).json({ error: "Missing toolCallId/toolCallList" });
    }

    // Vapi may send arguments as stringified JSON or as object
    let args = toolCall?.function?.arguments ?? {};
    if (typeof args === "string") {
      const s = args.trim();
      args = s ? JSON.parse(s) : {};
    }

    const callerPhone = args.callerPhone || args.phone || "";
    const pickupAddress = args.pickupAddress || args.fromAddress || args.from || "";
    const dropoffAddress = args.dropoffAddress || args.toAddress || args.to || "";

    if (!pickupAddress || !dropoffAddress) {
      return res.status(200).json({
        results: [
          {
            toolCallId,
            result: { error: true, message: "Missing pickupAddress or dropoffAddress" }
          }
        ]
      });
    }

    const from = await geocode(pickupAddress);
    const to = await geocode(dropoffAddress);
    const route = await directions(from, to);

    const tc = await taxicallerAddJob({ callerPhone, from, to, route });

    // Try to normalize success fields for the assistant prompt
    const jobId =
      tc?.data?.job?.id ||
      tc?.jobId ||
      tc?.job_id ||
      tc?.id ||
      null;

    return res.status(200).json({
      results: [
        {
          toolCallId,
          result: {
            error: false,
            jobId,
            taxicaller: tc
          }
        }
      ]
    });
  } catch (err) {
    console.error("book-taxi error:", err);

    // If we can, respond in tool-results format to avoid Vapi treating it as webhook failure
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body);
      const toolCallId = body?.message?.toolCallList?.[0]?.id;

      if (toolCallId) {
        return res.status(200).json({
          results: [
            {
              toolCallId,
              result: { error: true, message: String(err?.message || err) }
            }
          ]
        });
      }
    } catch {}

    return res.status(500).json({ error: String(err?.message || err) });
  }
});

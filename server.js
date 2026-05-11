  import express from "express";

const app = express();

// Accept text/plain bodies (Vapi/Taxicaller often send JSON as text)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/*", limit: "2mb" }));

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
  const respond = (toolCallId, result) =>
    res.status(200).json({ results: [{ toolCallId, result }] });

  try {
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("TAXICALLER_DSESSION");
    requireEnv("GOOGLE_MAPS_API_KEY");

    // 1) Body parse seguro
    let body = req.body;
    if (typeof body === "string") {
      const s = body.trim();
      body = s ? JSON.parse(s) : {};
    }

    // ... tu código igual ...
  } catch (err) {
    // ... tu catch igual ...
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ✅ ESTO VA AL FINAL DEL ARCHIVO (fuera de cualquier endpoint)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const TAXICALLER_BASE_URL = process.env.TAXICALLER_BASE_URL; // https://dn1001-rc.taxicaller.net
const TAXICALLER_DSESSION = process.env.TAXICALLER_DSESSION; // %7B%22id%22%3A...%7D  (VALUE ONLY)
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

  // dist en metros, edur en segundos
  const dist = leg.distance.value;
  const edur = leg.duration.value;

  // "route_points": array [lat, lon, lat, lon, ...]
  // Tomamos overview_polyline y la convertimos a puntos.
  // Para simplificar y evitar librerías, usaremos steps (más pesado pero funciona).
  // Si quieres, luego lo optimizamos con polyline decode.
  const route_points = [];
  for (const step of leg.steps) {
    route_points.push(step.start_location.lat, step.start_location.lng);
  }
  // agrega el final
  route_points.push(leg.end_location.lat, leg.end_location.lng);

  return { dist, edur, route_points };
}

async function taxicallerAddJob({ callerPhone, from, to, route }) {
  const url = `${TAXICALLER_BASE_URL}/DispatchApp/dispatch`;

  // Payload basado en tu captura. Mantengo lo esencial.
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
            booked_by: "VAPI",
            last_edited_by: "VAPI"
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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      // En tu captura el browser manda text/plain aunque sea JSON
      "content-type": "text/plain; charset=UTF-8",
      "accept": "*/*",
      "origin": TAXICALLER_BASE_URL,
      "cookie": `dsession=${TAXICALLER_DSESSION}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok || data?.retcode !== 0) {
    throw new Error(`Taxicaller addjob failed: HTTP ${res.status} body=${JSON.stringify(data)}`);
  }

  return data;
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/vapi/book-taxi", async (req, res) => {
  try {
    requireEnv("TAXICALLER_BASE_URL");
    requireEnv("TAXICALLER_DSESSION");
    requireEnv("GOOGLE_MAPS_API_KEY");

    const { callerPhone, pickupAddress, dropoffAddress } = req.body || {};
    if (!callerPhone || !pickupAddress || !dropoffAddress) {
      return res.status(400).json({
        error: "Missing required fields: callerPhone, pickupAddress, dropoffAddress"
      });
    }

    const from = await geocode(pickupAddress);
    const to = await geocode(dropoffAddress);
    const route = await directions(from, to);

    const addjobResp = await taxicallerAddJob({ callerPhone, from, to, route });

    const jobId = addjobResp?.data?.job?.id;
    const etaMs = addjobResp?.data?.slot?.ewhen; // epoch ms
    const price = addjobResp?.data?.fare?.price;
    const currency = addjobResp?.data?.fare?.currency;

    // ETA en minutos (aprox). Si etaMs viene en el pasado o raro, fallback 1.
    const now = Date.now();
    let etaMinutes = 1;
    if (typeof etaMs === "number") {
      etaMinutes = Math.max(1, Math.ceil((etaMs - now) / 60000));
    }

    return res.json({
      jobId,
      etaMinutes,
      price,
      currency,
      pickup: from.text,
      dropoff: to.text
    });
  } catch (e) {
    return res.status(500).json({ error: true, message: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));

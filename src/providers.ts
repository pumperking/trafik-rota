import AppleDirections from '../modules/apple-directions/src/AppleDirectionsModule';

export type LatLng = { latitude: number; longitude: number };

export type ProviderId = 'tomtom' | 'google' | 'apple';

export type Jam = {
  // Road name where the slowdown starts; undefined when the provider doesn't give one.
  name?: string;
  category: 'JAM' | 'ROAD_WORK' | 'ROAD_CLOSURE' | 'OTHER';
  severity: 1 | 2 | 3;
  lengthMeters: number;
  delaySeconds?: number;
  speedKmh?: number;
  coordinates: LatLng[];
};

export type RouteResult = {
  provider: ProviderId;
  // Main roads of the route, e.g. "D010 ve Yavuz Selim Blv üzerinden".
  label?: string;
  durationSeconds: number;
  // Travel time without traffic; undefined when the provider doesn't report one.
  baselineSeconds?: number;
  distanceMeters: number;
  coordinates: LatLng[];
  jams: Jam[];
  notices: string[];
};

export type Place = { label: string; position: LatLng };

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  tomtom: 'TomTom',
  google: 'Google',
  apple: 'Apple',
};

export const JAM_CATEGORY_NAMES: Record<Jam['category'], string> = {
  JAM: 'Sıkışıklık',
  ROAD_WORK: 'Yol çalışması',
  ROAD_CLOSURE: 'Yol kapalı',
  OTHER: 'Olay',
};

export const appleAvailable = AppleDirections != null;

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body?.error?.message ?? body?.detailedError?.message ?? body?.errorText ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function distanceMeters(a: LatLng, b: LatLng) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function pathLength(points: LatLng[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

// --- Address search -------------------------------------------------------------------------

async function tomtomSearch(key: string, query: string, near?: LatLng): Promise<Place[]> {
  const params = new URLSearchParams({ key, limit: '5', language: 'tr-TR', typeahead: 'true' });
  if (near) {
    params.set('lat', String(near.latitude));
    params.set('lon', String(near.longitude));
  }
  const body = await getJson(
    `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?${params}`
  );
  return (body.results ?? []).map((r: any) => ({
    label: r.poi?.name ? `${r.poi.name}, ${r.address.freeformAddress}` : r.address.freeformAddress,
    position: { latitude: r.position.lat, longitude: r.position.lon },
  }));
}

// OpenStreetMap search; knows many buildings and places that TomTom's index lacks.
async function photonSearch(query: string, near?: LatLng): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '5' });
  if (near) {
    params.set('lat', String(near.latitude));
    params.set('lon', String(near.longitude));
  }
  const body = await getJson(`https://photon.komoot.io/api/?${params}`);
  return (body.features ?? []).map((f: any) => {
    const p = f.properties;
    const parts = [p.name, p.street, p.district, p.city, p.state].filter(Boolean);
    return {
      label: [...new Set(parts)].join(', '),
      position: { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] },
    };
  });
}

// Hermes' toLocaleLowerCase can't be relied on for the Turkish dotted/dotless i.
const fold = (text: string) => text.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();

export async function searchPlaces(tomtomKey: string, query: string, near?: LatLng) {
  const sources = [photonSearch(query, near)];
  if (tomtomKey) sources.unshift(tomtomSearch(tomtomKey, query, near));
  const settled = await Promise.allSettled(sources);
  const places = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));

  const wanted = fold(query);
  const tokens = wanted.split(/\s+/).filter(Boolean);
  const score = (place: Place) => {
    const label = fold(place.label);
    const matched = tokens.filter((t) => label.includes(t)).length;
    // A place whose own name is exactly the query beats ones that merely contain its words.
    const exactName = label.split(',')[0].trim() === wanted ? 2 : 0;
    return matched + exactName + (label.startsWith(wanted) ? 1 : 0);
  };
  const seen = new Set<string>();
  return places
    .filter((p) => p.label && !seen.has(fold(p.label)) && seen.add(fold(p.label)))
    .map((place) => ({
      place,
      score: score(place),
      away: near ? distanceMeters(near, place.position) : 0,
    }))
    .sort((a, b) => b.score - a.score || a.away - b.away)
    .slice(0, 6)
    .map((s) => s.place);
}

// --- TomTom ---------------------------------------------------------------------------------

function parseTomtomRoute(route: any): RouteResult {
  const points: LatLng[] = route.legs.flatMap((leg: any) => leg.points);
  const total: number = route.summary.lengthInMeters;

  // Stretches of the route by road name, taken from the turn-by-turn instructions.
  const stretches: { fromPoint: number; name: string; meters: number }[] = [];
  const instructions: any[] = route.guidance?.instructions ?? [];
  let current: string | undefined;
  instructions.forEach((ins, i) => {
    current = ins.street || ins.roadNumbers?.[0] || current;
    if (!current) return;
    const end = instructions[i + 1]?.routeOffsetInMeters ?? total;
    stretches.push({
      fromPoint: ins.pointIndex,
      name: current,
      meters: end - ins.routeOffsetInMeters,
    });
  });
  const nameAt = (pointIndex: number) => {
    let name: string | undefined;
    for (const s of stretches) {
      if (s.fromPoint > pointIndex) break;
      name = s.name;
    }
    return name;
  };

  const metersByName = new Map<string, number>();
  for (const s of stretches) metersByName.set(s.name, (metersByName.get(s.name) ?? 0) + s.meters);
  const mainRoads = [...metersByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  const label =
    mainRoads.length > 0
      ? `${[...metersByName.keys()].filter((n) => mainRoads.includes(n)).join(' ve ')} üzerinden`
      : undefined;

  const jams: Jam[] = (route.sections ?? [])
    .filter((s: any) => s.sectionType === 'TRAFFIC')
    .filter((s: any) => s.simpleCategory !== 'JAM' || (s.delayInSeconds ?? 0) > 0)
    .map((s: any) => {
      const coordinates = points.slice(s.startPointIndex, s.endPointIndex + 1);
      const from = nameAt(s.startPointIndex);
      const to = nameAt(s.endPointIndex);
      return {
        name: from && to && from !== to ? `${from} – ${to}` : from ?? to,
        category: s.simpleCategory ?? 'OTHER',
        severity: s.magnitudeOfDelay === 3 ? 3 : s.magnitudeOfDelay === 2 ? 2 : 1,
        lengthMeters: pathLength(coordinates),
        delaySeconds: s.delayInSeconds,
        speedKmh: s.effectiveSpeedInKmh,
        coordinates,
      };
    });

  return {
    provider: 'tomtom',
    label,
    durationSeconds: route.summary.travelTimeInSeconds,
    baselineSeconds: route.summary.noTrafficTravelTimeInSeconds,
    distanceMeters: total,
    coordinates: points,
    jams,
    notices: [],
  };
}

export async function tomtomRoutes(key: string, from: LatLng, to: LatLng): Promise<RouteResult[]> {
  const params = new URLSearchParams({
    key,
    traffic: 'true',
    computeTravelTimeFor: 'all',
    sectionType: 'traffic',
    instructionsType: 'text',
    maxAlternatives: '2',
    language: 'tr-TR',
    travelMode: 'car',
  });
  const locations = `${from.latitude},${from.longitude}:${to.latitude},${to.longitude}`;
  const body = await getJson(
    `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?${params}`
  );
  const routes: RouteResult[] = (body.routes ?? []).map(parseTomtomRoute);
  if (routes.length === 0) throw new Error('Rota bulunamadı');
  // TomTom sometimes returns an alternative that differs from another route by a few metres.
  return routes.filter(
    (r, i) =>
      !routes
        .slice(0, i)
        .some(
          (o) =>
            o.label === r.label &&
            Math.abs(o.durationSeconds - r.durationSeconds) < 60 &&
            Math.abs(o.distanceMeters - r.distanceMeters) < 200
        )
  );
}

// --- Google ---------------------------------------------------------------------------------

// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

const seconds = (duration: string) => parseInt(duration, 10);

function parseGoogleRoute(route: any): RouteResult {
  const points = decodePolyline(route.polyline.encodedPolyline);

  // Google reports traffic as speed classes along the polyline, without names or delays.
  const jams: Jam[] = [];
  let open: { start: number; end: number; speed: string } | null = null;
  const close = () => {
    if (!open) return;
    const coordinates = points.slice(open.start, open.end + 1);
    jams.push({
      category: 'JAM',
      severity: open.speed === 'TRAFFIC_JAM' ? 2 : 1,
      lengthMeters: pathLength(coordinates),
      coordinates,
    });
    open = null;
  };
  for (const interval of route.travelAdvisory?.speedReadingIntervals ?? []) {
    const start = interval.startPolylinePointIndex ?? 0;
    const end = interval.endPolylinePointIndex ?? start;
    if (interval.speed !== 'SLOW' && interval.speed !== 'TRAFFIC_JAM') {
      close();
    } else if (open && open.speed === interval.speed && open.end === start) {
      open.end = end;
    } else {
      close();
      open = { start, end, speed: interval.speed };
    }
  }
  close();

  return {
    provider: 'google',
    label: route.description ? `${route.description} üzerinden` : undefined,
    durationSeconds: seconds(route.duration),
    baselineSeconds: route.staticDuration ? seconds(route.staticDuration) : undefined,
    distanceMeters: route.distanceMeters ?? 0,
    coordinates: points,
    jams: jams.filter((j) => j.lengthMeters >= 100),
    notices: route.warnings ?? [],
  };
}

export async function googleRoutes(key: string, from: LatLng, to: LatLng): Promise<RouteResult[]> {
  const body = await getJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': [
        'routes.duration',
        'routes.staticDuration',
        'routes.distanceMeters',
        'routes.description',
        'routes.warnings',
        'routes.polyline.encodedPolyline',
        'routes.travelAdvisory.speedReadingIntervals',
      ].join(','),
    },
    body: JSON.stringify({
      origin: { location: { latLng: from } },
      destination: { location: { latLng: to } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: true,
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
      languageCode: 'tr-TR',
      units: 'METRIC',
    }),
  });
  const routes: RouteResult[] = (body.routes ?? []).map(parseGoogleRoute);
  if (routes.length === 0) throw new Error('Rota bulunamadı');
  return routes;
}

// --- Apple ----------------------------------------------------------------------------------

export async function appleRoutes(from: LatLng, to: LatLng): Promise<RouteResult[]> {
  if (!AppleDirections) throw new Error('Yalnızca derlenmiş uygulamada çalışır');
  const response = await AppleDirections.getRoutes(
    from.latitude,
    from.longitude,
    to.latitude,
    to.longitude
  );
  return response.routes.map((route, i) => {
    // The traffic-aware ETA belongs to the primary route only.
    const eta = i === 0 ? response.etaSeconds ?? route.routeSeconds : route.routeSeconds;
    return {
      provider: 'apple',
      label: route.name ? `${route.name} üzerinden` : undefined,
      durationSeconds: eta,
      // MapKit has no explicit no-traffic time; the route's own estimate only counts as a
      // baseline when the traffic-aware ETA comes out longer than it.
      baselineSeconds: eta > route.routeSeconds ? route.routeSeconds : undefined,
      distanceMeters: route.distanceMeters,
      coordinates: route.coordinates,
      jams: [],
      notices: route.advisoryNotices,
    };
  });
}

export type MapApp = { name: string; url: string };

// No map app can be handed an exact path. Where the app supports it, points sampled along
// the chosen route are passed as via points to keep it on the same roads; Apple Maps and
// Waze only take a destination and pick their own route. Without a custom start the origin
// is left out, so each app starts from the phone's current location.
export function mapApps(route: RouteResult, customStart: boolean): MapApp[] {
  const points = route.coordinates;
  const total = pathLength(points);
  const via: LatLng[] = [];
  let travelled = 0;
  for (let i = 1; i < points.length - 1 && via.length < 3; i++) {
    travelled += distanceMeters(points[i - 1], points[i]);
    if (travelled >= (total * (via.length + 1)) / 4) via.push(points[i]);
  }
  const at = (p: LatLng) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  const from = points[0];
  const to = points[points.length - 1];

  const google = new URLSearchParams({ api: '1', destination: at(to), travelmode: 'driving' });
  if (via.length > 0) google.set('waypoints', via.map(at).join('|'));
  if (customStart) google.set('origin', at(from));

  const yandexNavi = new URLSearchParams({
    lat_to: String(to.latitude),
    lon_to: String(to.longitude),
  });
  if (customStart) {
    yandexNavi.set('lat_from', String(from.latitude));
    yandexNavi.set('lon_from', String(from.longitude));
  }
  via.forEach((p, i) => {
    yandexNavi.set(`lat_via_${i}`, String(p.latitude));
    yandexNavi.set(`lon_via_${i}`, String(p.longitude));
  });

  return [
    { name: 'Google Haritalar', url: `https://www.google.com/maps/dir/?${google}` },
    {
      name: 'Apple Haritalar',
      url: `https://maps.apple.com/?${customStart ? `saddr=${at(from)}&` : ''}daddr=${at(to)}&dirflg=d`,
    },
    { name: 'Yandex Navigasyon', url: `yandexnavi://build_route_on_map?${yandexNavi}` },
    {
      name: 'Yandex Haritalar',
      url: `yandexmaps://maps.yandex.com/?rtext=${[from, ...via, to].map(at).join('~')}&rtt=auto`,
    },
    { name: 'Waze', url: `https://waze.com/ul?ll=${at(to)}&navigate=yes` },
  ];
}

// --- Presentation helpers -------------------------------------------------------------------

export type Verdict = { label: string; color: string };

export function verdict(result: RouteResult): Verdict | null {
  if (result.baselineSeconds == null) return null;
  const delay = Math.max(0, result.durationSeconds - result.baselineSeconds);
  const ratio = delay / Math.max(1, result.baselineSeconds);
  if (delay < 120 || ratio < 0.1) return { label: 'Trafik akıcı', color: '#1e8e3e' };
  if (ratio < 0.25) return { label: 'Hafif trafik', color: '#c27c00' };
  if (ratio < 0.5) return { label: 'Yoğun trafik', color: '#d9541e' };
  return { label: 'Çok yoğun trafik', color: '#c5221f' };
}

export const JAM_COLORS: Record<Jam['severity'], string> = {
  1: '#f29900',
  2: '#d93025',
  3: '#8c1d18',
};

export function formatDuration(totalSeconds: number) {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} dk`;
  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

export function formatDistance(meters: number) {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

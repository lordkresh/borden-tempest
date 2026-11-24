const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_MI = 3958.7613;
const POLY_EPS = 1e-9;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isValidLatLon(lat, lon) {
  return isFiniteNum(lat) && isFiniteNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function normalizeLon(lon) {
  if (!isFiniteNum(lon)) return NaN;
  let wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180 && lon > 0) wrapped = 180;
  return wrapped === 0 ? 0 : wrapped;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  if (!isValidLatLon(lat1, lon1) || !isValidLatLon(lat2, lon2)) return NaN;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  const clamped = Math.max(0, Math.min(1, a));
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(clamped));
}

export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  if (!isValidLatLon(lat1, lon1) || !isValidLatLon(lat2, lon2)) return NaN;
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD2DEG) % 360 + 360) % 360;
}

export function destinationPoint(lat, lon, bearingDeg, distanceMiles) {
  if (!isValidLatLon(lat, lon) || !isFiniteNum(bearingDeg) || !isFiniteNum(distanceMiles) || distanceMiles < 0) {
    return null;
  }
  const ang = distanceMiles / EARTH_RADIUS_MI;
  const brng = bearingDeg * DEG2RAD;
  const phi1 = lat * DEG2RAD;
  const lam1 = lon * DEG2RAD;
  const sinPhi2 = Math.max(-1, Math.min(1, Math.sin(phi1) * Math.cos(ang) + Math.cos(phi1) * Math.sin(ang) * Math.cos(brng)));
  const phi2 = Math.asin(sinPhi2);
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(ang) * Math.cos(phi1),
      Math.cos(ang) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: phi2 * RAD2DEG, lon: normalizeLon(lam2 * RAD2DEG) };
}

export function degToCompass(deg) {
  if (deg === null || deg === undefined || deg === '') return '--';
  const n = Number(deg);
  if (!Number.isFinite(n)) return '--';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((n % 360) + 360) % 360) / 22.5) % 16];
}

export function angularDiffDeg(a, b) {
  if (!isFiniteNum(a) || !isFiniteNum(b)) return NaN;
  const diff = ((((b - a + 180) % 360) + 360) % 360) - 180;
  return diff === 0 ? 0 : diff;
}

/**
 * Computes Storm Cell Time-on-Target (TOT) and Closest Point of Approach (CPA)
 * using local tangent-plane vector projection.
 * @param {number} userLat
 * @param {number} userLon
 * @param {number} cellLat
 * @param {number} cellLon
 * @param {number} moveToBearingDeg - Direction storm is moving TOWARD (0=N, 90=E)
 * @param {number} speedMph - Storm ground speed in mph
 */
export function computeStormIntercept(userLat, userLon, cellLat, cellLon, moveToBearingDeg, speedMph) {
  if (!isValidLatLon(userLat, userLon) || !isValidLatLon(cellLat, cellLon)) {
    return {
      distanceMi: NaN,
      bearingFromUser: NaN,
      compassFromUser: '--',
      cpaMiles: NaN,
      etaMinutes: null,
      verdict: 'INVALID',
      verdictLabel: 'Coordinates Unavailable'
    };
  }

  const distMi = haversineMiles(userLat, userLon, cellLat, cellLon);
  const bearingFromUser = initialBearingDeg(userLat, userLon, cellLat, cellLon);
  const bearingToUser = initialBearingDeg(cellLat, cellLon, userLat, userLon);

  // Storm cell directly overhead — never misclassify as MOVING_AWAY when distMi === 0
  if (distMi <= 0.5) {
    return {
      distanceMi: distMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      cpaMiles: distMi,
      etaMinutes: 0,
      verdict: 'DIRECT_INTERCEPT',
      verdictLabel: `Overhead Now (CPA ${distMi.toFixed(1)} mi)`
    };
  }

  if (!isFiniteNum(speedMph) || speedMph < 3 || !isFiniteNum(moveToBearingDeg)) {
    return {
      distanceMi: distMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      cpaMiles: distMi,
      etaMinutes: null,
      verdict: distMi <= 12 ? 'NEARBY_STATIONARY' : 'STATIONARY',
      verdictLabel: distMi <= 12 ? 'Nearby / Slow-Moving' : 'Slow-Moving'
    };
  }

  // Vector from cell to user (in miles, East = +x, North = +y)
  const relAngleRad = (bearingToUser - moveToBearingDeg) * DEG2RAD;
  const alongTrackMi = distMi * Math.cos(relAngleRad);
  const crossTrackMi = Math.abs(distMi * Math.sin(relAngleRad));

  if (alongTrackMi <= 0) {
    return {
      distanceMi: distMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      cpaMiles: distMi,
      etaMinutes: null,
      verdict: 'MOVING_AWAY',
      verdictLabel: 'Moving Away'
    };
  }

  const etaMinutes = Math.round((alongTrackMi / speedMph) * 60);
  let verdict = 'PASSING';
  let verdictLabel = `Passing ${crossTrackMi.toFixed(1)} mi off-track`;

  if (crossTrackMi <= 5 && etaMinutes <= 90) {
    verdict = 'DIRECT_INTERCEPT';
    verdictLabel = `Direct Intercept (CPA ${crossTrackMi.toFixed(1)} mi)`;
  } else if (crossTrackMi <= 12 && etaMinutes <= 90) {
    verdict = 'NEAR_MISS';
    verdictLabel = `Close Pass (CPA ${crossTrackMi.toFixed(1)} mi)`;
  }

  return {
    distanceMi: distMi,
    bearingFromUser,
    compassFromUser: degToCompass(bearingFromUser),
    cpaMiles: crossTrackMi,
    etaMinutes,
    verdict,
    verdictLabel
  };
}

export function buildThreatConePolygon(cellLat, cellLon, moveToBearingDeg, speedMph, minutes = 45) {
  if (
    !isValidLatLon(cellLat, cellLon) ||
    !isFiniteNum(speedMph) ||
    speedMph < 5 ||
    !isFiniteNum(moveToBearingDeg) ||
    !isFiniteNum(minutes) ||
    minutes <= 0
  ) {
    return null;
  }
  const travelMi = Math.min(75, Math.max(8, (speedMph * minutes) / 60));
  const spreadDeg = 16;
  const steps = 6;
  const ring = [[cellLon, cellLat]];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const angle = (((moveToBearingDeg - spreadDeg + frac * spreadDeg * 2) % 360) + 360) % 360;
    const cosCurve = 1 + 0.05 * Math.sin(frac * Math.PI);
    const pt = destinationPoint(cellLat, cellLon, angle, travelMi * cosCurve);
    if (!pt) return null;
    ring.push([pt.lon, pt.lat]);
  }
  ring.push([cellLon, cellLat]);
  return ring;
}

export function buildMotionVectorLine(cellLat, cellLon, moveToBearingDeg, speedMph, minutes = 45) {
  if (
    !isValidLatLon(cellLat, cellLon) ||
    !isFiniteNum(speedMph) ||
    speedMph < 5 ||
    !isFiniteNum(moveToBearingDeg) ||
    !isFiniteNum(minutes) ||
    minutes <= 0
  ) {
    return null;
  }
  const travelMi = Math.min(75, Math.max(8, (speedMph * minutes) / 60));
  const tip = destinationPoint(cellLat, cellLon, moveToBearingDeg, travelMi);
  if (!tip) return null;
  const headLenMi = Math.max(2.2, Math.min(5.5, travelMi * 0.16));
  const leftWing = destinationPoint(tip.lat, tip.lon, (((moveToBearingDeg + 150) % 360) + 360) % 360, headLenMi);
  const rightWing = destinationPoint(tip.lat, tip.lon, (((moveToBearingDeg + 210) % 360) + 360) % 360, headLenMi);
  if (!leftWing || !rightWing) return null;
  return {
    tip,
    coords: [[cellLon, cellLat], [tip.lon, tip.lat]],
    arrowCoords: [[leftWing.lon, leftWing.lat], [tip.lon, tip.lat], [rightWing.lon, rightWing.lat]]
  };
}

export function buildCirclePolygon(centerLat, centerLon, radiusMiles, steps = 64) {
  if (!isValidLatLon(centerLat, centerLon) || !isFiniteNum(radiusMiles) || radiusMiles <= 0) return [];
  const safeSteps = Math.max(8, Math.floor(isFiniteNum(steps) ? steps : 64));
  const ring = [];
  for (let i = 0; i <= safeSteps; i++) {
    const brg = (i / safeSteps) * 360;
    const pt = destinationPoint(centerLat, centerLon, brg, radiusMiles);
    if (pt) ring.push([pt.lon, pt.lat]);
  }
  return ring;
}

/**
 * Validates a GeoJSON linear ring of [lon, lat] coordinate pairs.
 * Rejects non-arrays, <3 distinct vertices, NaN/non-numeric entries,
 * impossible latitudes (|lat| > 90, e.g., swapped [lat, lon] pairs), and out-of-range longitudes.
 */
export function validateGeoJsonRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return { valid: false, reason: 'TOO_FEW_VERTICES', swappedSuspected: false };
  }
  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i];
    if (!Array.isArray(pt) || pt.length < 2 || !isFiniteNum(pt[0]) || !isFiniteNum(pt[1])) {
      return { valid: false, reason: 'MALFORMED_COORDINATE', swappedSuspected: false };
    }
    const [lon, lat] = pt;
    if (Math.abs(lat) > 90) {
      return {
        valid: false,
        reason: 'INVALID_LATITUDE',
        swappedSuspected: Math.abs(lon) <= 90 && Math.abs(lat) <= 180
      };
    }
    if (Math.abs(lon) > 360) {
      return { valid: false, reason: 'INVALID_LONGITUDE', swappedSuspected: false };
    }
  }
  // Verify at least 3 vertices after ignoring duplicate closing vertex
  const first = ring[0];
  const last = ring[ring.length - 1];
  const isClosed = Math.abs(first[0] - last[0]) <= 1e-12 && Math.abs(first[1] - last[1]) <= 1e-12;
  const effectiveLen = isClosed ? ring.length - 1 : ring.length;
  if (effectiveLen < 3) {
    return { valid: false, reason: 'TOO_FEW_VERTICES', swappedSuspected: false };
  }
  return { valid: true, reason: null, swappedSuspected: false };
}

function unwrapRingCoords(ring) {
  const check = validateGeoJsonRing(ring);
  if (!check.valid) return null;

  const first = ring[0];
  const last = ring[ring.length - 1];
  const isClosed = Math.abs(first[0] - last[0]) <= 1e-12 && Math.abs(first[1] - last[1]) <= 1e-12;
  const count = isClosed ? ring.length - 1 : ring.length;

  let prevLon = normalizeLon(ring[0][0]);
  const coords = [[prevLon, ring[0][1]]];
  let minLon = prevLon;
  let maxLon = prevLon;
  let minLat = ring[0][1];
  let maxLat = ring[0][1];

  for (let i = 1; i < count; i++) {
    let currLon = normalizeLon(ring[i][0]);
    let delta = currLon - prevLon;
    while (delta > 180) {
      currLon -= 360;
      delta -= 360;
    }
    while (delta < -180) {
      currLon += 360;
      delta += 360;
    }
    const lat = ring[i][1];
    coords.push([currLon, lat]);
    prevLon = currLon;
    if (currLon < minLon) minLon = currLon;
    if (currLon > maxLon) maxLon = currLon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return { coords, minLon, maxLon, minLat, maxLat };
}

export function geometryCentroid(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'Feature') return geometryCentroid(geometry.geometry);

  if (geometry.type === 'Point') {
    const c = geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2 || !isValidLatLon(c[1], c[0])) return null;
    return { lon: normalizeLon(c[0]), lat: c[1] };
  }

  let candidateRings = [];
  if (geometry.type === 'Polygon') {
    if (Array.isArray(geometry.coordinates) && geometry.coordinates[0]) {
      candidateRings = [geometry.coordinates[0]];
    }
  } else if (geometry.type === 'MultiPolygon') {
    if (Array.isArray(geometry.coordinates)) {
      candidateRings = geometry.coordinates
        .map((poly) => (Array.isArray(poly) ? poly[0] : null))
        .filter(Boolean);
    }
  } else if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const g of geometry.geometries) {
      const ctr = geometryCentroid(g);
      if (ctr) return ctr;
    }
    return null;
  }

  if (!candidateRings.length) return null;

  let sumLon = 0;
  let sumLat = 0;
  let totalPts = 0;
  let refLon = null;

  for (const ring of candidateRings) {
    const unwrapped = unwrapRingCoords(ring);
    if (!unwrapped) continue;
    for (const [x, y] of unwrapped.coords) {
      let adjLon = x;
      if (refLon === null) {
        refLon = adjLon;
      } else {
        while (adjLon - refLon > 180) adjLon -= 360;
        while (adjLon - refLon < -180) adjLon += 360;
      }
      sumLon += adjLon;
      sumLat += y;
      totalPts++;
    }
  }

  if (totalPts === 0) return null;
  return { lon: normalizeLon(sumLon / totalPts), lat: sumLat / totalPts };
}

function isPointOnSegment(px, py, x1, y1, x2, y2, eps = POLY_EPS) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= eps * eps) {
    return Math.hypot(px - x1, py - y1) <= eps;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY) <= eps;
}

/**
 * Classifies a point (lon, lat) against a GeoJSON linear ring:
 * returns 'BOUNDARY' | 'INSIDE' | 'OUTSIDE' | 'INVALID'.
 * Handles vertices, edges, and antimeridian (±180°) wrapping polygons cleanly.
 */
function classifyPointInRing(lon, lat, ring) {
  if (!isValidLatLon(lat, lon)) return 'INVALID';
  const unwrapped = unwrapRingCoords(ring);
  if (!unwrapped) return 'INVALID';

  const { coords, minLon, maxLon, minLat, maxLat } = unwrapped;
  if (lat < minLat - POLY_EPS || lat > maxLat + POLY_EPS) return 'OUTSIDE';

  const midLon = (minLon + maxLon) / 2;
  let baseLon = normalizeLon(lon);
  while (baseLon - midLon > 180) baseLon -= 360;
  while (baseLon - midLon < -180) baseLon += 360;

  const candidates = [baseLon];
  if (maxLon - minLon > 180) {
    if (baseLon + 360 <= maxLon + POLY_EPS) candidates.push(baseLon + 360);
    if (baseLon - 360 >= minLon - POLY_EPS) candidates.push(baseLon - 360);
  }

  for (const px of candidates) {
    if (px < minLon - POLY_EPS || px > maxLon + POLY_EPS) continue;

    // 1. Exact vertex & edge boundary check first
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i][0], yi = coords[i][1];
      const xj = coords[j][0], yj = coords[j][1];
      if (isPointOnSegment(px, lat, xj, yj, xi, yi, POLY_EPS)) {
        return 'BOUNDARY';
      }
    }

    // 2. Jordan-curve ray casting
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i][0], yi = coords[i][1];
      const xj = coords[j][0], yj = coords[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (px < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    if (inside) return 'INSIDE';
  }

  return 'OUTSIDE';
}

export function pointInRing(lon, lat, ring) {
  const status = classifyPointInRing(lon, lat, ring);
  return status === 'INSIDE' || status === 'BOUNDARY';
}

function pointInPolygonRings(lon, lat, rings) {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  const outerStatus = classifyPointInRing(lon, lat, rings[0]);
  if (outerStatus !== 'INSIDE' && outerStatus !== 'BOUNDARY') return false;

  for (let h = 1; h < rings.length; h++) {
    const holeStatus = classifyPointInRing(lon, lat, rings[h]);
    if (holeStatus === 'INVALID') return false;
    // Strictly inside a hole excludes the point; sitting on a hole's boundary remains on the polygon boundary (INSIDE)
    if (holeStatus === 'INSIDE') return false;
  }
  return true;
}

/**
 * Hardened point-in-polygon check for GeoJSON Polygon, MultiPolygon, or GeometryCollection.
 * Treats points on vertices/edges (including hole boundaries) as INSIDE, handles antimeridian
 * (±180°) wrapping polygons, and safely rejects swapped/malformed/NaN coordinates without throwing.
 */
export function isPointInGeometry(lat, lon, geometry) {
  if (!geometry || typeof geometry !== 'object') return false;
  if (!isValidLatLon(lat, lon)) return false;

  if (geometry.type === 'Feature') {
    return isPointInGeometry(lat, lon, geometry.geometry);
  }
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) return false;
    for (const poly of geometry.coordinates) {
      if (pointInPolygonRings(lon, lat, poly)) return true;
    }
    return false;
  }
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) return false;
    for (const g of geometry.geometries) {
      if (isPointInGeometry(lat, lon, g)) return true;
    }
    return false;
  }
  return false;
}


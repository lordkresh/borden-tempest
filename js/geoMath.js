const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_MI = 3958.7613;

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

export function destinationPoint(lat, lon, bearingDeg, distanceMiles) {
  const ang = distanceMiles / EARTH_RADIUS_MI;
  const brng = bearingDeg * DEG2RAD;
  const phi1 = lat * DEG2RAD;
  const lam1 = lon * DEG2RAD;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(ang) + Math.cos(phi1) * Math.sin(ang) * Math.cos(brng)
  );
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(ang) * Math.cos(phi1),
      Math.cos(ang) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: phi2 * RAD2DEG, lon: ((lam2 * RAD2DEG + 540) % 360) - 180 };
}

export function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return '--';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function angularDiffDeg(a, b) {
  let diff = ((b - a + 540) % 360) - 180;
  return diff;
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
  const distMi = haversineMiles(userLat, userLon, cellLat, cellLon);
  const bearingFromUser = initialBearingDeg(userLat, userLon, cellLat, cellLon);
  const bearingToUser = initialBearingDeg(cellLat, cellLon, userLat, userLon);

  if (!speedMph || speedMph < 3 || moveToBearingDeg == null || Number.isNaN(moveToBearingDeg)) {
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
  if (!speedMph || speedMph < 5 || moveToBearingDeg == null || Number.isNaN(moveToBearingDeg)) return null;
  const travelMi = Math.min(75, Math.max(8, (speedMph * minutes) / 60));
  const spreadDeg = 16;
  const steps = 6;
  const ring = [[cellLon, cellLat]];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const angle = (moveToBearingDeg - spreadDeg + frac * spreadDeg * 2 + 360) % 360;
    const cosCurve = 1 + 0.05 * Math.sin(frac * Math.PI);
    const pt = destinationPoint(cellLat, cellLon, angle, travelMi * cosCurve);
    ring.push([pt.lon, pt.lat]);
  }
  ring.push([cellLon, cellLat]);
  return ring;
}

export function buildMotionVectorLine(cellLat, cellLon, moveToBearingDeg, speedMph, minutes = 45) {
  if (!speedMph || speedMph < 5 || moveToBearingDeg == null || Number.isNaN(moveToBearingDeg)) return null;
  const travelMi = Math.min(75, Math.max(8, (speedMph * minutes) / 60));
  const tip = destinationPoint(cellLat, cellLon, moveToBearingDeg, travelMi);
  const headLenMi = Math.max(2.2, Math.min(5.5, travelMi * 0.16));
  const leftWing = destinationPoint(tip.lat, tip.lon, (moveToBearingDeg + 150) % 360, headLenMi);
  const rightWing = destinationPoint(tip.lat, tip.lon, (moveToBearingDeg + 210) % 360, headLenMi);
  return {
    tip,
    coords: [[cellLon, cellLat], [tip.lon, tip.lat]],
    arrowCoords: [[leftWing.lon, leftWing.lat], [tip.lon, tip.lat], [rightWing.lon, rightWing.lat]]
  };
}

export function buildCirclePolygon(centerLat, centerLon, radiusMiles, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 360;
    const pt = destinationPoint(centerLat, centerLon, brg, radiusMiles);
    ring.push([pt.lon, pt.lat]);
  }
  return ring;
}

export function geometryCentroid(geometry) {
  if (!geometry) return null;
  let coords = [];
  if (geometry.type === 'Point') return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  if (geometry.type === 'Polygon') coords = geometry.coordinates[0] || [];
  if (geometry.type === 'MultiPolygon') coords = geometry.coordinates?.[0]?.[0] || [];
  if (!coords.length) return null;
  let sumLon = 0, sumLat = 0;
  for (const c of coords) {
    sumLon += c[0];
    sumLat += c[1];
  }
  return { lon: sumLon / coords.length, lat: sumLat / coords.length };
}

function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Accurate ray-casting check for whether (lat, lon) lies inside a GeoJSON Polygon or MultiPolygon.
 */
export function isPointInGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates || [];
    if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lon, lat, rings[h])) return false;
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates || []) {
      if (poly.length && pointInRing(lon, lat, poly[0])) {
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
          if (pointInRing(lon, lat, poly[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
  }
  return false;
}


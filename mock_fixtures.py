"""
100% Mocked Network Fixtures & Dynamic Scenario Router for Borden Tempest PWA Verification.
Zero live network calls to AWS S3, IEM, Open-Meteo, NWS, SPC, WPC, MapLibre CDN, or Google Fonts.
"""

from __future__ import annotations

import base64
import datetime
import json
import urllib.parse
from typing import Any, Dict, List, Optional

# Minimal valid 1x1 transparent PNG (67 bytes, valid signature + IHDR + IDAT + IEND)
VALID_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

# Realistic MapLibre GL mock that tracks sources, layers, events, and errors in-memory
MOCK_MAPLIBRE_JS = r"""
(function () {
  window.__MAPLIBRE_MOCK_INSTANCES__ = [];
  window.__MAPLIBRE_SIMULATE_WEBGL_THROW__ = false;

  class MockSource {
    constructor(id, spec) {
      this.id = id;
      this.spec = spec;
      this.data = spec && spec.data ? spec.data : null;
      this.setDataCount = 0;
    }
    setData(data) {
      this.data = data;
      this.setDataCount += 1;
    }
  }

  class MockMap {
    constructor(opts) {
      if (window.__MAPLIBRE_SIMULATE_WEBGL_THROW__) {
        throw new Error('Failed to initialize WebGL context (simulated)');
      }
      this.options = opts || {};
      this.container = typeof opts.container === 'string'
        ? document.getElementById(opts.container)
        : opts.container;
      this._sources = new Map();
      this._layers = new Map();
      this._listeners = new Map();
      this._canvas = document.createElement('canvas');
      this._canvas.width = 300;
      this._canvas.height = 200;
      this._canvas.style.width = '100%';
      this._canvas.style.height = '100%';
      if (this.container) {
        this.container.innerHTML = '';
        this.container.appendChild(this._canvas);
      }
      this.removed = false;
      this.resizeCount = 0;
      this.flyToHistory = [];
      this.styleLoadCount = 0;
      window.__MAPLIBRE_MOCK_INSTANCES__.push(this);
      setTimeout(() => {
        if (!this.removed) {
          this.styleLoadCount += 1;
          this._emit('style.load', {});
          this._emit('load', {});
        }
      }, 15);
    }
    on(ev, fn) {
      if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
      this._listeners.get(ev).add(fn);
      return this;
    }
    off(ev, fn) {
      if (this._listeners.has(ev)) this._listeners.get(ev).delete(fn);
      return this;
    }
    _emit(ev, payload) {
      const fns = this._listeners.get(ev);
      if (!fns) return;
      for (const fn of [...fns]) {
        fn(payload);
      }
    }
    getCanvas() { return this._canvas; }
    getZoom() { return 7.5; }
    resize() { this.resizeCount += 1; }
    flyTo(opts) { this.flyToHistory.push(opts); }
    setStyle(styleUrl) {
      this._layers.clear();
      this._sources.clear();
      this.options.style = styleUrl;
      setTimeout(() => {
        if (!this.removed) {
          this.styleLoadCount += 1;
          this._emit('style.load', {});
        }
      }, 15);
    }
    addSource(id, spec) {
      if (this._sources.has(id)) throw new Error(`Source "${id}" already exists`);
      this._sources.set(id, new MockSource(id, spec));
    }
    getSource(id) { return this._sources.get(id); }
    removeSource(id) { this._sources.delete(id); }
    addLayer(layer, beforeId) {
      if (this._layers.has(layer.id)) throw new Error(`Layer "${layer.id}" already exists`);
      this._layers.set(layer.id, {
        ...layer,
        paint: { ...(layer.paint || {}) },
        layout: { ...(layer.layout || {}) },
        beforeId: beforeId || null
      });
    }
    getLayer(id) { return this._layers.get(id); }
    removeLayer(id) { this._layers.delete(id); }
    setPaintProperty(id, prop, val) {
      const l = this._layers.get(id);
      if (!l) throw new Error(`Layer "${id}" not found`);
      l.paint[prop] = val;
    }
    setLayoutProperty(id, prop, val) {
      const l = this._layers.get(id);
      if (!l) throw new Error(`Layer "${id}" not found`);
      l.layout[prop] = val;
    }
    queryRenderedFeatures() { return []; }
    remove() {
      this.removed = true;
      this._layers.clear();
      this._sources.clear();
      this._listeners.clear();
      if (this.container && this._canvas.parentNode === this.container) {
        this.container.removeChild(this._canvas);
      }
    }
    getStyle() {
      return {
        layers: [...this._layers.values()],
        sources: Object.fromEntries(this._sources.entries())
      };
    }
  }

  window.maplibregl = { Map: MockMap };
})();
"""


def _iso_utc(dt: datetime.datetime) -> str:
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_om_local_or_utc(dt: datetime.datetime) -> str:
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M")


def build_open_meteo_payload(
    now_utc: Optional[datetime.datetime] = None,
    age_minutes: float = 2.0,
    cape: float = 150.0,
    wind10: float = 8.0,
    wind850: float = 18.0,
    wind500: float = 30.0,
) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    base_time = now - datetime.timedelta(minutes=age_minutes)
    # Build 36 hourly slots starting 6h ago so current hour index always matches
    start_hr = (base_time - datetime.timedelta(hours=6)).replace(minute=0, second=0, microsecond=0)
    times = [_iso_utc(start_hr + datetime.timedelta(hours=h)) for h in range(36)]
    n = len(times)
    return {
        "latitude": 34.6581,
        "longitude": -88.5667,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "timezone_abbreviation": "GMT",
        "current_units": {
            "time": "iso8601",
            "temperature_2m": "°F",
            "wind_speed_10m": "mp/h",
        },
        "current": {
            "time": _iso_utc(base_time),
            "temperature_2m": 74.2,
            "relative_humidity_2m": 62,
            "apparent_temperature": 75.0,
            "dew_point_2m": 60.1,
            "precipitation": 0.0,
            "rain": 0.0,
            "snowfall": 0.0,
            "weather_code": 2,
            "cloud_cover": 35,
            "pressure_msl": 1015.4,
            "surface_pressure": 998.2,
            "wind_speed_10m": wind10,
            "wind_direction_10m": 190,
            "wind_gusts_10m": wind10 + 5,
        },
        "hourly_units": {
            "time": "iso8601",
            "temperature_2m": "°F",
            "wind_speed_10m": "mp/h",
            "freezing_level_height": "m",
        },
        "hourly": {
            "time": times,
            "temperature_2m": [74.0] * n,
            "dew_point_2m": [60.0] * n,
            "relative_humidity_2m": [62] * n,
            "apparent_temperature": [75.0] * n,
            "precipitation_probability": [15] * n,
            "precipitation": [0.0] * n,
            "snowfall": [0.0] * n,
            "weather_code": [2] * n,
            "pressure_msl": [1015.4] * n,
            "surface_pressure": [998.2] * n,
            "visibility": [16093.44] * n,
            "wind_speed_10m": [wind10] * n,
            "wind_direction_10m": [190] * n,
            "wind_speed_925hPa": [(wind10 + wind850) / 2.0] * n,
            "wind_direction_925hPa": [210] * n,
            "wind_speed_850hPa": [wind850] * n,
            "wind_direction_850hPa": [230] * n,
            "wind_speed_700hPa": [(wind850 + wind500) / 2.0] * n,
            "wind_direction_700hPa": [250] * n,
            "wind_speed_500hPa": [wind500] * n,
            "wind_direction_500hPa": [265] * n,
            "temperature_700hPa": [42.0] * n,
            "temperature_500hPa": [10.0] * n,
            "geopotential_height_700hPa": [3100] * n,
            "geopotential_height_500hPa": [5750] * n,
            "wind_gusts_10m": [wind10 + 6] * n,
            "cape": [cape] * n,
            "convective_inhibition": [-15] * n,
            "freezing_level_height": [3800] * n,
            "soil_temperature_0cm": [68.0] * n,
            "soil_temperature_6cm": [66.0] * n,
        },
    }


def build_nws_points_payload() -> Dict[str, Any]:
    return {
        "properties": {
            "cwa": "MEG",
            "radarStation": "KGWX",
            "forecast": "https://api.weather.gov/gridpoints/MEG/88,41/forecast",
            "forecastHourly": "https://api.weather.gov/gridpoints/MEG/88,41/forecast/hourly",
            "observationStations": "https://api.weather.gov/gridpoints/MEG/88,41/stations",
            "relativeLocation": {
                "properties": {"city": "Booneville", "state": "MS"}
            },
        }
    }


def build_nws_forecast_payload(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    periods = []
    for i in range(6):
        st = now + datetime.timedelta(hours=i * 12)
        en = st + datetime.timedelta(hours=12)
        periods.append({
            "number": i + 1,
            "name": ["Today", "Tonight", "Tomorrow", "Tomorrow Night", "Day 3", "Day 3 Night"][i],
            "startTime": _iso_utc(st),
            "endTime": _iso_utc(en),
            "isDaytime": i % 2 == 0,
            "temperature": 75 if i % 2 == 0 else 58,
            "temperatureUnit": "F",
            "windSpeed": "10 mph",
            "windDirection": "S",
            "shortForecast": "Partly Cloudy",
            "detailedForecast": "Partly cloudy with mild south winds.",
            "probabilityOfPrecipitation": {"value": 15},
        })
    return {"properties": {"periods": periods}}


def build_nws_hourly_payload(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    periods = []
    for i in range(24):
        st = now + datetime.timedelta(hours=i)
        en = st + datetime.timedelta(hours=1)
        periods.append({
            "number": i + 1,
            "startTime": _iso_utc(st),
            "endTime": _iso_utc(en),
            "isDaytime": True,
            "temperature": 74,
            "temperatureUnit": "F",
            "windSpeed": "8 mph",
            "windDirection": "S",
            "shortForecast": "Partly Cloudy",
            "probabilityOfPrecipitation": {"value": 10},
        })
    return {"properties": {"periods": periods}}


def build_nws_stations_payload() -> Dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [-88.77, 34.27]},
                "properties": {
                    "stationIdentifier": "KTUP",
                    "name": "Tupelo Regional Airport",
                },
            }
        ],
    }


def build_nws_observation_payload(now_utc: Optional[datetime.datetime] = None, age_minutes: float = 4.0) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    ts = now - datetime.timedelta(minutes=age_minutes)
    return {
        "properties": {
            "timestamp": _iso_utc(ts),
            "textDescription": "Partly Cloudy",
            "temperature": {"value": 23.3, "unitCode": "wmoUnit:degC"},
            "dewpoint": {"value": 15.5, "unitCode": "wmoUnit:degC"},
            "relativeHumidity": {"value": 61.0},
            "windDirection": {"value": 190},
            "windSpeed": {"value": 12.9, "unitCode": "wmoUnit:km_h-1"},
            "windGust": {"value": None},
            "barometricPressure": {"value": 101540},
            "seaLevelPressure": {"value": 101540},
            "visibility": {"value": 16093},
        }
    }


def build_tornado_warning_feature(
    now_utc: Optional[datetime.datetime] = None,
    alert_id: str = "urn:oid:2.49.0.1.840.0.tempest.tor.001",
    expired: bool = False,
    cancelled: bool = False,
) -> Dict[str, Any]:
    """Synthetic Tornado Warning polygon directly enclosing Booneville, MS (34.6581, -88.5667)."""
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    sent = now - datetime.timedelta(minutes=5)
    expires = (now - datetime.timedelta(minutes=2)) if expired else (now + datetime.timedelta(minutes=30))
    return {
        "id": alert_id,
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-88.75, 34.55],
                [-88.40, 34.55],
                [-88.40, 34.78],
                [-88.75, 34.78],
                [-88.75, 34.55],
            ]],
        },
        "properties": {
            "id": alert_id,
            "event": "Tornado Warning",
            "status": "Cancel" if cancelled else "Actual",
            "messageType": "Cancel" if cancelled else "Alert",
            "severity": "Extreme",
            "urgency": "Immediate",
            "sent": _iso_utc(sent),
            "effective": _iso_utc(sent),
            "expires": _iso_utc(expires),
            "ends": _iso_utc(expires),
            "headline": "Tornado Warning issued for Prentiss County MS until further notice",
            "description": "A confirmed large and extremely dangerous tornado was located near Booneville moving northeast at 40 mph.",
            "instruction": "TAKE COVER NOW! Move to an interior room on the lowest floor of a sturdy building.",
            "areaDesc": "Prentiss, MS",
            "senderName": "NWS Memphis TN",
            "parameters": {
                "tornadoDetection": ["OBSERVED"],
                "tornadoDamageThreat": ["CONSIDERABLE"],
                "eventMotionDescription": ["2026-11-23T22:00:00-00:00...storm...225DEG...35KT"],
            },
        },
    }


def build_expired_and_superseded_alerts(now_utc: Optional[datetime.datetime] = None) -> List[Dict[str, Any]]:
    """Includes an expired warning and a superseded severe warning pair to verify purging."""
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    expired_warn = {
        "id": "urn:oid:2.49.0.1.840.0.tempest.expired.001",
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-88.8, 34.5], [-88.3, 34.5], [-88.3, 34.8], [-88.8, 34.8], [-88.8, 34.5]]],
        },
        "properties": {
            "id": "urn:oid:2.49.0.1.840.0.tempest.expired.001",
            "event": "Severe Thunderstorm Warning",
            "status": "Actual",
            "messageType": "Alert",
            "sent": _iso_utc(now - datetime.timedelta(minutes=50)),
            "effective": _iso_utc(now - datetime.timedelta(minutes=50)),
            "expires": _iso_utc(now - datetime.timedelta(minutes=10)),
            "ends": _iso_utc(now - datetime.timedelta(minutes=10)),
            "headline": "EXPIRED Severe Thunderstorm Warning",
            "description": "This warning already expired 10 minutes ago.",
            "areaDesc": "Prentiss, MS",
            "senderName": "NWS Memphis TN",
            "parameters": {},
        },
    }
    superseded_old = {
        "id": "urn:oid:2.49.0.1.840.0.tempest.superseded.old",
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-88.8, 34.5], [-88.3, 34.5], [-88.3, 34.8], [-88.8, 34.8], [-88.8, 34.5]]],
        },
        "properties": {
            "id": "urn:oid:2.49.0.1.840.0.tempest.superseded.old",
            "event": "Severe Thunderstorm Warning",
            "status": "Actual",
            "messageType": "Alert",
            "sent": _iso_utc(now - datetime.timedelta(minutes=15)),
            "effective": _iso_utc(now - datetime.timedelta(minutes=15)),
            "expires": _iso_utc(now + datetime.timedelta(minutes=20)),
            "ends": _iso_utc(now + datetime.timedelta(minutes=20)),
            "headline": "SUPERSEDED Severe Thunderstorm Warning",
            "description": "Should be purged because cancelled by newer reference.",
            "areaDesc": "Prentiss, MS",
            "senderName": "NWS Memphis TN",
            "parameters": {},
        },
    }
    cancel_ref = {
        "id": "urn:oid:2.49.0.1.840.0.tempest.superseded.cancel",
        "type": "Feature",
        "geometry": None,
        "properties": {
            "id": "urn:oid:2.49.0.1.840.0.tempest.superseded.cancel",
            "event": "Severe Thunderstorm Warning",
            "status": "Actual",
            "messageType": "Cancel",
            "sent": _iso_utc(now - datetime.timedelta(minutes=3)),
            "effective": _iso_utc(now - datetime.timedelta(minutes=3)),
            "expires": _iso_utc(now + datetime.timedelta(minutes=15)),
            "references": [
                {
                    "@id": "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.tempest.superseded.old",
                    "identifier": "urn:oid:2.49.0.1.840.0.tempest.superseded.old",
                    "sender": "w-nws.webmaster@noaa.gov",
                    "sent": _iso_utc(now - datetime.timedelta(minutes=15)),
                }
            ],
            "headline": "Cancel notice for superseded warning",
            "areaDesc": "Prentiss, MS",
            "senderName": "NWS Memphis TN",
            "parameters": {},
        },
    }
    return [expired_warn, superseded_old, cancel_ref]


def build_iem_radar_scans(now_utc: Optional[datetime.datetime] = None, latest_age_minutes: float = 3.0) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    latest = now - datetime.timedelta(minutes=latest_age_minutes)
    scans = []
    for i in range(9, -1, -1):
        ts = latest - datetime.timedelta(minutes=i * 5)
        scans.append({"ts": ts.strftime("%Y-%m-%dT%H:%MZ")})
    return {"scans": scans}


def build_rich_storm_cells(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [-88.62, 34.60]},
                "properties": {
                    "nexrad": "KGWX",
                    "storm_id": "K4",
                    "valid": _iso_utc(now - datetime.timedelta(minutes=2)),
                    "tvs": "TVS",
                    "meso": "M4",
                    "max_dbz": 66,
                    "max_dbz_height": 22,
                    "max_size": 1.75,
                    "poh": 90,
                    "posh": 80,
                    "vil": 58,
                    "top": 52,
                    "drct": 225,
                    "sknt": 38,
                    "range": 62,
                },
            }
        ],
    }


def build_rich_lsr(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [-88.48, 34.72]},
                "properties": {
                    "typetext": "TORNADO",
                    "magnitude": 0,
                    "unit": "",
                    "city": "Booneville",
                    "county": "PRENTISS",
                    "state": "MS",
                    "source": "TRAINED SPOTTER",
                    "valid": _iso_utc(now - datetime.timedelta(minutes=6)),
                    "remark": "Large cone tornado observed crossing Highway 45 northeast of Booneville.",
                },
            }
        ],
    }


def build_rich_watch(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-89.5, 34.0], [-87.8, 34.0], [-87.8, 35.3], [-89.5, 35.3], [-89.5, 34.0]]],
                },
                "properties": {
                    "num": 412,
                    "type": "TOR",
                    "is_pds": True,
                    "pds": "Y",
                    "issue": _iso_utc(now - datetime.timedelta(minutes=45)),
                    "expire": _iso_utc(now + datetime.timedelta(hours=4)),
                    "max_hail": "2.5 in",
                    "max_gust": "75 mph",
                },
            }
        ],
    }


def build_rich_mcd(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-89.2, 34.2], [-88.0, 34.2], [-88.0, 35.1], [-89.2, 35.1], [-89.2, 34.2]]],
                },
                "properties": {
                    "num": 1984,
                    "watch_confidence": "80%",
                    "concerning": "Tornado Watch 412 — Intense Supercells",
                    "issue": _iso_utc(now - datetime.timedelta(minutes=20)),
                    "expire": _iso_utc(now + datetime.timedelta(hours=2)),
                    "discussion": "Strong low-level shear and 0-1 km SRH > 300 m2/s2 support long-track supercells across NE Mississippi.",
                },
            }
        ],
    }


def build_rich_spc_outlook() -> Dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-89.6, 33.8], [-87.5, 33.8], [-87.5, 35.5], [-89.6, 35.5], [-89.6, 33.8]]],
                },
                "properties": {"LABEL": "MDT", "LABEL2": "Moderate Risk"},
            }
        ],
    }


def build_rich_wpc_flood(now_utc: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    now = now_utc or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-89.3, 34.1], [-87.9, 34.1], [-87.9, 35.2], [-89.3, 35.2], [-89.3, 34.1]]],
                },
                "properties": {
                    "OUTLOOK": "ENH",
                    "LABEL": "MDT",
                    "VALID": _iso_utc(now - datetime.timedelta(hours=1)),
                    "EXPIRE": _iso_utc(now + datetime.timedelta(hours=8)),
                },
            }
        ],
    }


class MockWeatherRouter:
    """
    Intercepts all external URLs requested by headless Chrome / Service Worker
    and serves deterministic mocked responses.
    """

    def __init__(self, scenario: str = "clear"):
        self.scenario = scenario
        self.request_counts: Dict[str, int] = {}

    def set_scenario(self, scenario: str) -> None:
        self.scenario = scenario

    def handle(self, url: str, method: str, req: Dict[str, Any]) -> Dict[str, Any]:
        self.request_counts[url] = self.request_counts.get(url, 0) + 1
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or "").lower()
        path = parsed.path or ""

        # Strict block mode for pure unit tests (any external call = live leakage!)
        if self.scenario == "strict_block":
            return {"leak": True, "reason": f"Live external request in strict_block mode: {url}"}

        # Static third-party UI dependencies (mocked cleanly offline)
        if host in ("fonts.googleapis.com", "fonts.gstatic.com"):
            return {"status": 200, "content_type": "text/css; charset=utf-8", "body": "/* mocked fonts */"}

        if host == "unpkg.com" and "maplibre-gl" in path:
            if path.endswith(".css"):
                return {"status": 200, "content_type": "text/css; charset=utf-8", "body": "/* mocked maplibre css */"}
            return {"status": 200, "content_type": "application/javascript; charset=utf-8", "body": MOCK_MAPLIBRE_JS}

        if host == "tiles.openfreemap.org":
            return {"status": 200, "content_type": "application/json", "body": {"version": 8, "sources": {}, "layers": []}}

        # Offline / 503 failure simulation for all weather & radar APIs
        if self.scenario == "offline_503":
            if "tile.py" in path or host.endswith("amazonaws.com"):
                return {"status": 503, "content_type": "text/plain", "body": "Service Unavailable"}
            return {"fail": "InternetDisconnected"}

        if self.scenario == "http_503":
            return {"status": 503, "content_type": "application/json", "body": {"error": "Upstream 503"}}

        now = datetime.datetime.now(datetime.timezone.utc)
        delay_ms = 500 if self.scenario == "slow_3g" else 0

        def _resp(payload: Dict[str, Any]) -> Dict[str, Any]:
            if delay_ms > 0:
                payload = {**payload, "delay_ms": delay_ms}
            return payload

        # Open-Meteo Forecast API
        if host == "api.open-meteo.com":
            age = 24.0 if self.scenario == "stale_open_meteo" else 2.0
            if self.scenario == "weather_systems_rich":
                om_body = build_open_meteo_payload(now_utc=now, age_minutes=age, cape=2100.0, wind10=16.0, wind850=48.0, wind500=68.0)
            else:
                om_body = build_open_meteo_payload(now_utc=now, age_minutes=age)
            return _resp({
                "status": 200,
                "content_type": "application/json; charset=utf-8",
                "body": om_body,
            })

        # Open-Meteo Geocoding API
        if host == "geocoding-api.open-meteo.com":
            qs = urllib.parse.parse_qs(parsed.query)
            qname = (qs.get("name", ["Booneville"])[0] or "Booneville").strip().lower()
            if "tupelo" in qname:
                result_item = {
                    "name": "Tupelo",
                    "admin1": "Mississippi",
                    "admin2": "Lee County",
                    "country": "United States",
                    "country_code": "US",
                    "latitude": 34.2576,
                    "longitude": -88.7034,
                }
            else:
                result_item = {
                    "name": "Booneville",
                    "admin1": "Mississippi",
                    "admin2": "Prentiss County",
                    "country": "United States",
                    "country_code": "US",
                    "latitude": 34.6581,
                    "longitude": -88.5667,
                }
            return _resp({
                "status": 200,
                "content_type": "application/json; charset=utf-8",
                "body": {"results": [result_item]},
            })

        # NWS API
        if host == "api.weather.gov":
            if path.startswith("/points/"):
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_nws_points_payload()})
            if path.endswith("/forecast"):
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_nws_forecast_payload(now)})
            if path.endswith("/forecast/hourly"):
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_nws_hourly_payload(now)})
            if path.endswith("/stations"):
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_nws_stations_payload()})
            if "/observations/latest" in path:
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_nws_observation_payload(now)})
            if path.startswith("/products/types/AFD/"):
                return _resp({"status": 200, "content_type": "application/ld+json", "body": {"@graph": [{"id": "afd-mock-1"}]}})
            if path.startswith("/products/"):
                return _resp({
                    "status": 200,
                    "content_type": "application/ld+json",
                    "body": {
                        "issuanceTime": _iso_utc(now - datetime.timedelta(minutes=10)),
                        "issuingOffice": "NWS Memphis TN",
                        "productText": ".SYNOPSIS...\nMocked Area Forecast Discussion for automated QA.",
                    },
                })
            if path.startswith("/alerts/active"):
                feats: List[Dict[str, Any]] = []
                if self.scenario in ("tornado_active", "weather_systems_rich"):
                    feats = [build_tornado_warning_feature(now, expired=False)] + build_expired_and_superseded_alerts(now)
                elif self.scenario == "tornado_second_critical":
                    first_tor = build_tornado_warning_feature(now, expired=False)
                    second_tor = build_tornado_warning_feature(
                        now,
                        alert_id="urn:oid:2.49.0.1.840.0.tempest.tor.002",
                        expired=False,
                    )
                    second_tor["properties"]["headline"] = "SECOND Tornado Warning — Tornado Emergency for Booneville MS"
                    second_tor["properties"]["parameters"]["tornadoDamageThreat"] = ["CATASTROPHIC"]
                    feats = [first_tor, second_tor] + build_expired_and_superseded_alerts(now)
                elif self.scenario == "tornado_expired":
                    feats = [build_tornado_warning_feature(now, expired=True)] + build_expired_and_superseded_alerts(now)
                elif self.scenario == "tornado_cancelled":
                    feats = [build_tornado_warning_feature(now, cancelled=True)]
                return _resp({
                    "status": 200,
                    "content_type": "application/geo+json",
                    "body": {"type": "FeatureCollection", "features": feats},
                })
            return _resp({"status": 404, "content_type": "application/json", "body": {"title": "Mock 404"}})

        # Iowa Environmental Mesonet (IEM) NEXRAD / Storm Intel / Tiles
        if host == "mesonet.agron.iastate.edu":
            if path.startswith("/json/radar.py"):
                age = 22.0 if self.scenario == "stale_radar" else 3.0
                return _resp({
                    "status": 200,
                    "content_type": "application/json",
                    "body": build_iem_radar_scans(now_utc=now, latest_age_minutes=age),
                })
            if path.startswith("/geojson/"):
                if self.scenario == "weather_systems_rich":
                    if "nexrad_attr" in path:
                        return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_storm_cells(now)})
                    if "lsr.geojson" in path:
                        return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_lsr(now)})
                    if "mcd.geojson" in path:
                        return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_mcd(now)})
                    if "spc_watch.geojson" in path:
                        return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_watch(now)})
                return _resp({
                    "status": 200,
                    "content_type": "application/geo+json",
                    "body": {"type": "FeatureCollection", "features": []},
                })
            if "tile.py" in path or path.endswith(".png"):
                return _resp({
                    "status": 200,
                    "content_type": "image/png",
                    "body": VALID_PNG_1X1,
                })
            return _resp({"status": 404, "content_type": "text/plain", "body": "Mock IEM 404"})

        # SPC / WPC MapServer & GeoJSON
        if host in ("mapservices.weather.noaa.gov", "www.spc.noaa.gov"):
            if self.scenario == "weather_systems_rich":
                if "wpc_precip_hazards" in path:
                    return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_wpc_flood(now)})
                return _resp({"status": 200, "content_type": "application/geo+json", "body": build_rich_spc_outlook()})
            return _resp({
                "status": 200,
                "content_type": "application/geo+json",
                "body": {"type": "FeatureCollection", "features": []},
            })

        # AWS S3 NEXRAD & additional live weather/radar domains (mocked explicitly for SW never-cache test)
        if host.endswith("amazonaws.com"):
            return {
                "status": 200,
                "content_type": "application/octet-stream",
                "body": b"SDUS54 KGWX 232200\r\nN0BGWX\r\n" + b"\x00" * 128,
            }
        if host in ("radar.weather.gov", "tilecache.rainviewer.com"):
            return {
                "status": 200,
                "content_type": "image/png",
                "body": VALID_PNG_1X1,
            }
        if host == "nomads.ncep.noaa.gov":
            return {
                "status": 200,
                "content_type": "application/octet-stream",
                "body": b"GRIB" + b"\x00" * 64,
            }

        # Anything unrecognized is treated as a LIVE NETWORK LEAKAGE VIOLATION!
        return {"leak": True, "reason": f"Unexpected external host attempted: {url}"}

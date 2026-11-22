import { buildCirclePolygon, destinationPoint } from './geoMath.js';

const BASEMAP_STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  liberty: 'https://tiles.openfreemap.org/styles/liberty'
};

const PRODUCT_LEGENDS = {
  CONUS_MOSAIC: { min: '5 dBZ', max: '75+ dBZ', grad: 'linear-gradient(90deg,#04e9e7,#019ff4,#0300f4,#02fd02,#01c501,#fdf802,#fd9500,#fd0000,#d40000,#f800fd,#ffffff)' },
  N0B: { min: '5 dBZ', max: '75+ dBZ', grad: 'linear-gradient(90deg,#04e9e7,#019ff4,#0300f4,#02fd02,#01c501,#fdf802,#fd9500,#fd0000,#d40000,#f800fd,#ffffff)' },
  N0G: { min: '-64 kt (In)', max: '+64 kt (Out)', grad: 'linear-gradient(90deg,#00ff44,#009922,#1f2937,#990022,#ff2244,#ff00ff)' },
  N0C: { min: '0.20 (Debris)', max: '1.00 (Uniform)', grad: 'linear-gradient(90deg,#0044ff,#00e5ff,#ffee00,#ff4444,#ff00cc)' },
  N0X: { min: '-2 dB', max: '+6 dB (Hail/Drop)', grad: 'linear-gradient(90deg,#3b82f6,#10b981,#facc15,#f97316,#ef4444,#d946ef)' },
  EET: { min: '5 kft', max: '65+ kft', grad: 'linear-gradient(90deg,#38bdf8,#22c55e,#facc15,#f97316,#ef4444,#e879f9)' }
};

export class RadarMapController {
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
    this.map = null;
    this.ready = false;
    this.basemap = 'dark';
    this.opacity = 0.78;
    this.frames = [];
    this.frameIdx = 0;
    this.playing = false;
    this.speedMultiplier = 1;
    this.playTimer = null;
    this.productCode = 'CONUS_MOSAIC';
    this.userLoc = { lat: 34.65, lon: -88.56 };
    this.overlayData = {
      alerts: [],
      stormCells: [],
      lsrGeoJson: { type: 'FeatureCollection', features: [] },
      mcdGeoJson: { type: 'FeatureCollection', features: [] },
      spcWatchesGeoJson: { type: 'FeatureCollection', features: [] },
      wpcFloodGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1GeoJson: { type: 'FeatureCollection', features: [] }
    };
    this.layerVisibility = {
      alerts: true,
      cells: true,
      spc: true,
      watches: true,
      flood: false,
      mcd: true,
      lsr: true
    };
  }

  init(lat, lon, basemap = 'dark', opacity = 0.78) {
    this.userLoc = { lat, lon };
    this.basemap = basemap;
    this.opacity = opacity;

    if (this.map) {
      this.map.resize();
      return;
    }
    if (typeof window.maplibregl === 'undefined') return;

    this.map = new window.maplibregl.Map({
      container: this.containerId,
      style: BASEMAP_STYLES[basemap] || BASEMAP_STYLES.dark,
      center: [lon, lat],
      zoom: 7.2,
      attributionControl: true
    });

    this.map.on('style.load', () => {
      this.ready = true;
      this._attachAllLayers();
    });

    this.map.on('click', (e) => {
      if (!this.ready) return;
      const cellLayers = ['tempest_cells_circle', 'tempest_cells_ring', 'tempest_cells_label'].filter((id) => this.map.getLayer(id));
      const cellHits = cellLayers.length ? this.map.queryRenderedFeatures(e.point, { layers: cellLayers }) : [];
      if (cellHits.length && this.callbacks.onInspectCell) {
        const cid = cellHits[0].properties?.id;
        const found = this.overlayData.stormCells.find((c) => c.id === cid);
        if (found) {
          this.callbacks.onInspectCell(found);
          return;
        }
      }

      const lsrHits = this.map.queryRenderedFeatures(e.point, { layers: ['tempest_lsr_circle'].filter((id) => this.map.getLayer(id)) });
      if (lsrHits.length && this.callbacks.onInspectLsr) {
        const feat = lsrHits[0];
        this.callbacks.onInspectLsr({
          properties: feat.properties || {},
          coords: feat.geometry?.coordinates || [e.lngLat.lng, e.lngLat.lat]
        });
        return;
      }

      const alertHits = this.map.queryRenderedFeatures(e.point, { layers: ['tempest_alerts_fill'].filter((id) => this.map.getLayer(id)) });
      if (alertHits.length && this.callbacks.onInspectAlert) {
        const aid = alertHits[0].properties?.id;
        const found = this.overlayData.alerts.find((a) => a.id === aid);
        if (found) {
          this.callbacks.onInspectAlert(found);
        }
      }
    });
  }

  resize() {
    if (this.map) {
      setTimeout(() => this.map && this.map.resize(), 40);
    }
  }

  setUserLocation(lat, lon) {
    this.userLoc = { lat, lon };
    this._updateUserSource();
    if (this.ready) this._updateGeoJsonSources();
  }

  flyTo(lat, lon, zoom = 8.2, isUserOrigin = false) {
    if (isUserOrigin) {
      this.setUserLocation(lat, lon);
    }
    if (this.map) {
      this.map.flyTo({ center: [lon, lat], zoom, duration: 750 });
    }
  }

  setBasemap(styleKey) {
    if (this.basemap === styleKey || !BASEMAP_STYLES[styleKey]) return;
    this.basemap = styleKey;
    if (this.map) {
      this.ready = false;
      this.map.setStyle(BASEMAP_STYLES[styleKey]);
    }
  }

  setOpacity(val) {
    this.opacity = Math.max(0.2, Math.min(1, val));
    if (!this.ready || !this.map) return;
    this.frames.forEach((fr, idx) => {
      const lid = `tempest_radar_lyr_${idx}`;
      if (this.map.getLayer(lid)) {
        this.map.setPaintProperty(lid, 'raster-opacity', idx === this.frameIdx ? this.opacity : 0);
      }
    });
  }

  setLayerVisibility(key, visible) {
    this.layerVisibility[key] = visible;
    if (!this.ready || !this.map) return;
    const vis = visible ? 'visible' : 'none';
    const mapIds = {
      alerts: ['tempest_alerts_fill', 'tempest_alerts_line'],
      cells: [
        'tempest_range_rings_line',
        'tempest_range_rings_label',
        'tempest_cones_fill',
        'tempest_cones_line',
        'tempest_vectors_casing',
        'tempest_vectors_line',
        'tempest_tot_line',
        'tempest_cells_ring',
        'tempest_cells_circle',
        'tempest_cells_label'
      ],
      spc: ['tempest_spc_fill', 'tempest_spc_line'],
      watches: ['tempest_watches_fill', 'tempest_watches_line'],
      flood: ['tempest_flood_fill', 'tempest_flood_line'],
      mcd: ['tempest_mcd_fill', 'tempest_mcd_line'],
      lsr: ['tempest_lsr_circle']
    };
    for (const lid of mapIds[key] || []) {
      if (this.map.getLayer(lid)) {
        this.map.setLayoutProperty(lid, 'visibility', vis);
      }
    }
  }

  setOverlayData(data) {
    this.overlayData = { ...this.overlayData, ...data };
    if (this.ready) this._updateGeoJsonSources();
  }

  setFrames(frames, productCode) {
    this.stopPlayback();
    this.frames = frames || [];
    this.productCode = productCode || 'CONUS_MOSAIC';
    this.frameIdx = Math.max(0, this.frames.length - 1);
    this._renderLegend();
    if (this.ready) {
      this._rebuildRadarLayers();
    }
    this._notifyFrame();
  }

  scrubTo(idx) {
    if (!this.frames.length) return;
    this.frameIdx = Math.max(0, Math.min(this.frames.length - 1, idx));
    if (this.ready && this.map) {
      this.frames.forEach((_, i) => {
        const lid = `tempest_radar_lyr_${i}`;
        if (this.map.getLayer(lid)) {
          this.map.setPaintProperty(lid, 'raster-opacity', i === this.frameIdx ? this.opacity : 0);
        }
      });
    }
    this._notifyFrame();
  }

  togglePlayback() {
    if (this.playing) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
    return this.playing;
  }

  startPlayback() {
    if (this.frames.length <= 1) return;
    this.stopPlayback();
    this.playing = true;
    const stepMs = this.speedMultiplier === 2 ? 380 : 750;
    this.playTimer = setInterval(() => {
      const next = (this.frameIdx + 1) % this.frames.length;
      this.scrubTo(next);
    }, stepMs);
  }

  stopPlayback() {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  toggleSpeed() {
    this.speedMultiplier = this.speedMultiplier === 1 ? 2 : 1;
    if (this.playing) this.startPlayback();
    return this.speedMultiplier;
  }

  _notifyFrame() {
    const fr = this.frames[this.frameIdx] || null;
    if (this.callbacks.onFrameChange) {
      this.callbacks.onFrameChange(fr, this.frameIdx, this.frames.length);
    }
  }

  _renderLegend() {
    const el = document.getElementById('radar-legend-bar');
    if (!el) return;
    const cfg = PRODUCT_LEGENDS[this.productCode] || PRODUCT_LEGENDS.CONUS_MOSAIC;
    el.innerHTML = `
      <span>${cfg.min}</span>
      <div class="legend-gradient" style="background:${cfg.grad}"></div>
      <span>${cfg.max}</span>
    `;
  }

  _attachAllLayers() {
    if (!this.map) return;
    this._rebuildRadarLayers();

    // SPC Convective Outlook (Day 1-3 Cat & Tor/Hail/Wind Prob)
    this.map.addSource('tempest_spc', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_spc_fill',
      type: 'fill',
      source: 'tempest_spc',
      paint: {
        'fill-color': [
          'match', ['coalesce', ['get', 'LABEL'], ''],
          'TSTM', '#4caf50', 'MRGL', '#2e7d32', 'SLGT', '#fdd835', 'ENH', '#fb8c00', 'MDT', '#e53935', 'HIGH', '#d500f9',
          '0.02', '#2e7d32', '2%', '#2e7d32', '0.05', '#8d6e63', '5%', '#8d6e63', '0.10', '#fdd835', '10%', '#fdd835',
          '0.15', '#fb8c00', '15%', '#fb8c00', '0.30', '#e53935', '30%', '#e53935', '0.45', '#d500f9', '45%', '#d500f9',
          '0.60', '#aa00ff', '60%', '#aa00ff', 'SIGN', '#ff1744',
          ['coalesce', ['get', 'fill'], '#1e88e5']
        ],
        'fill-opacity': 0.16
      }
    });
    this.map.addLayer({
      id: 'tempest_spc_line',
      type: 'line',
      source: 'tempest_spc',
      paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#ffd54f'], 'line-width': 1.6 }
    });

    // WPC Excessive Rainfall (Flash Flood ERO)
    this.map.addSource('tempest_flood', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_flood_fill',
      type: 'fill',
      source: 'tempest_flood',
      paint: {
        'fill-color': [
          'match', ['coalesce', ['get', 'OUTLOOK'], ''],
          'MRGL', '#26a69a', 'SLGT', '#fdd835', 'MDT', '#ef5350', 'HIGH', '#d500f9',
          '#00bfa5'
        ],
        'fill-opacity': 0.2
      }
    });
    this.map.addLayer({
      id: 'tempest_flood_line',
      type: 'line',
      source: 'tempest_flood',
      paint: { 'line-color': '#00e676', 'line-width': 1.8, 'line-dasharray': [2, 2] }
    });

    // SPC Watch Boxes (PDS Tornado magenta, Tornado red, Severe amber)
    this.map.addSource('tempest_watches', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_watches_fill',
      type: 'fill',
      source: 'tempest_watches',
      paint: { 'fill-color': ['get', 'watchColor'], 'fill-opacity': 0.11 }
    });
    this.map.addLayer({
      id: 'tempest_watches_line',
      type: 'line',
      source: 'tempest_watches',
      paint: { 'line-color': ['get', 'watchColor'], 'line-width': 2.4, 'line-dasharray': [4, 2] }
    });

    // SPC MCD
    this.map.addSource('tempest_mcd', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_mcd_fill',
      type: 'fill',
      source: 'tempest_mcd',
      paint: { 'fill-color': '#d946ef', 'fill-opacity': 0.12 }
    });
    this.map.addLayer({
      id: 'tempest_mcd_line',
      type: 'line',
      source: 'tempest_mcd',
      paint: { 'line-color': '#d946ef', 'line-width': 2, 'line-dasharray': [4, 2] }
    });

    // NWS Alerts Polygons
    this.map.addSource('tempest_alerts', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_alerts_fill',
      type: 'fill',
      source: 'tempest_alerts',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 }
    });
    this.map.addLayer({
      id: 'tempest_alerts_line',
      type: 'line',
      source: 'tempest_alerts',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 }
    });

    // Concentric Tactical Range Rings (15 / 30 / 60 mi)
    this.map.addSource('tempest_range_rings', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_range_rings_line',
      type: 'line',
      source: 'tempest_range_rings',
      paint: {
        'line-color': '#38bdf8',
        'line-opacity': 0.24,
        'line-width': 1.1,
        'line-dasharray': [4, 4]
      }
    });
    this.map.addSource('tempest_range_rings_labels', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_range_rings_label',
      type: 'symbol',
      source: 'tempest_range_rings_labels',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-anchor': 'bottom'
      },
      paint: {
        'text-color': 'rgba(125, 211, 252, 0.72)',
        'text-halo-color': '#070c16',
        'text-halo-width': 1.5
      }
    });

    // Storm Cell Threat Cones, Centerline Motion Vectors & TOT Lines
    this.map.addSource('tempest_cones', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_cones_fill',
      type: 'fill',
      source: 'tempest_cones',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 }
    });
    this.map.addLayer({
      id: 'tempest_cones_line',
      type: 'line',
      source: 'tempest_cones',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.85, 'line-dasharray': [3, 2] }
    });

    this.map.addSource('tempest_vectors', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_vectors_casing',
      type: 'line',
      source: 'tempest_vectors',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#060b14', 'line-width': 4.4, 'line-opacity': 0.8 }
    });
    this.map.addLayer({
      id: 'tempest_vectors_line',
      type: 'line',
      source: 'tempest_vectors',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.4 }
    });

    this.map.addSource('tempest_tot', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_tot_line',
      type: 'line',
      source: 'tempest_tot',
      paint: { 'line-color': '#00e5ff', 'line-width': 2.2, 'line-dasharray': [3, 2] }
    });

    // Local Storm Reports
    this.map.addSource('tempest_lsr', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_lsr_circle',
      type: 'circle',
      source: 'tempest_lsr',
      paint: {
        'circle-radius': 5.5,
        'circle-color': '#facc15',
        'circle-stroke-color': '#090d16',
        'circle-stroke-width': 1.8
      }
    });

    // Storm Cell Markers (Outer Rotation Halo + Core Dot + Velocity Vector Tag)
    this.map.addSource('tempest_cells', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_cells_ring',
      type: 'circle',
      source: 'tempest_cells',
      filter: ['>=', ['get', 'threatScore'], 3],
      paint: {
        'circle-radius': 14,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.72
      }
    });
    this.map.addLayer({
      id: 'tempest_cells_circle',
      type: 'circle',
      source: 'tempest_cells',
      paint: {
        'circle-radius': ['case', ['>=', ['get', 'threatScore'], 3], 8.5, 6.5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2
      }
    });
    this.map.addLayer({
      id: 'tempest_cells_label',
      type: 'symbol',
      source: 'tempest_cells',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.45],
        'text-anchor': 'top',
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#f8fafc',
        'text-halo-color': '#060a12',
        'text-halo-width': 1.8
      }
    });

    // User Location Beacon
    this.map.addSource('tempest_user', { type: 'geojson', data: this._emptyFc() });
    this.map.addLayer({
      id: 'tempest_user_ring',
      type: 'circle',
      source: 'tempest_user',
      paint: {
        'circle-radius': 18,
        'circle-color': 'transparent',
        'circle-stroke-color': '#00d4ff',
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.45
      }
    });
    this.map.addLayer({
      id: 'tempest_user_halo',
      type: 'circle',
      source: 'tempest_user',
      paint: { 'circle-radius': 11, 'circle-color': '#00d4ff', 'circle-opacity': 0.28 }
    });
    this.map.addLayer({
      id: 'tempest_user_dot',
      type: 'circle',
      source: 'tempest_user',
      paint: { 'circle-radius': 5.5, 'circle-color': '#00d4ff', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.4 }
    });

    this._updateUserSource();
    this._updateGeoJsonSources();
    Object.entries(this.layerVisibility).forEach(([k, v]) => this.setLayerVisibility(k, v));
  }

  _rebuildRadarLayers() {
    if (!this.map) return;
    // Remove old radar layers/sources
    for (let i = 0; i < 20; i++) {
      const lid = `tempest_radar_lyr_${i}`;
      const sid = `tempest_radar_src_${i}`;
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
      if (this.map.getSource(sid)) this.map.removeSource(sid);
    }

    const beforeLayer = this.map.getLayer('tempest_spc_fill') ? 'tempest_spc_fill' : undefined;
    this.frames.forEach((fr, idx) => {
      const sid = `tempest_radar_src_${idx}`;
      const lid = `tempest_radar_lyr_${idx}`;
      this.map.addSource(sid, {
        type: 'raster',
        tiles: [fr.tileUrl],
        tileSize: 256
      });
      this.map.addLayer({
        id: lid,
        type: 'raster',
        source: sid,
        paint: {
          'raster-opacity': idx === this.frameIdx ? this.opacity : 0,
          'raster-fade-duration': 0
        }
      }, beforeLayer);
    });
  }

  _updateUserSource() {
    if (!this.ready || !this.map?.getSource('tempest_user')) return;
    this.map.getSource('tempest_user').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [this.userLoc.lon, this.userLoc.lat] },
        properties: {}
      }]
    });

    const ringRadii = [15, 30, 60];
    this.map.getSource('tempest_range_rings')?.setData({
      type: 'FeatureCollection',
      features: ringRadii.map((mi) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: buildCirclePolygon(this.userLoc.lat, this.userLoc.lon, mi, 64) },
        properties: { radiusMi: mi }
      }))
    });
    this.map.getSource('tempest_range_rings_labels')?.setData({
      type: 'FeatureCollection',
      features: ringRadii.map((mi) => {
        const pt = destinationPoint(this.userLoc.lat, this.userLoc.lon, 0, mi);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
          properties: { label: `${mi} mi` }
        };
      })
    });
  }

  _updateGeoJsonSources() {
    if (!this.ready || !this.map) return;

    const alertFeatures = (this.overlayData.alerts || [])
      .filter((a) => a.geometry)
      .map((a) => ({
        type: 'Feature',
        geometry: a.geometry,
        properties: { id: a.id, event: a.event, color: a.color }
      }));
    this.map.getSource('tempest_alerts')?.setData({ type: 'FeatureCollection', features: alertFeatures });

    const cells = this.overlayData.stormCells || [];
    const cellFeatures = cells.map((c) => {
      const prefix = c.tvs ? 'TVS' : c.meso ? 'SUP' : c.threatScore >= 2 ? 'SVR' : '';
      const dirTag = c.speedMph >= 3 && c.moveToCompass && c.moveToCompass !== '--'
        ? ` →${c.moveToCompass} ${c.speedMph}`
        : '';
      const label = prefix ? `${prefix} ${c.stormId}${dirTag}` : `${c.stormId}${dirTag}`;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
          id: c.id,
          color: c.color,
          threatScore: c.threatScore || 1,
          label
        }
      };
    });
    this.map.getSource('tempest_cells')?.setData({ type: 'FeatureCollection', features: cellFeatures });

    const coneFeatures = cells
      .filter((c) => c.coneCoords)
      .map((c) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [c.coneCoords] },
        properties: { id: c.id, color: c.color }
      }));
    this.map.getSource('tempest_cones')?.setData({ type: 'FeatureCollection', features: coneFeatures });

    const vectorFeatures = [];
    for (const c of cells) {
      if (!c.vectorLine) continue;
      vectorFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: c.vectorLine.coords },
        properties: { id: c.id, color: c.color }
      });
      vectorFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: c.vectorLine.arrowCoords },
        properties: { id: c.id, color: c.color }
      });
    }
    this.map.getSource('tempest_vectors')?.setData({ type: 'FeatureCollection', features: vectorFeatures });

    const totFeatures = cells
      .filter((c) => c.intercept.verdict === 'DIRECT_INTERCEPT' || c.intercept.verdict === 'NEAR_MISS')
      .map((c) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[c.lon, c.lat], [this.userLoc.lon, this.userLoc.lat]] },
        properties: { id: c.id }
      }));
    this.map.getSource('tempest_tot')?.setData({ type: 'FeatureCollection', features: totFeatures });

    this.map.getSource('tempest_spc')?.setData(this.overlayData.spcDay1GeoJson || this._emptyFc());
    this.map.getSource('tempest_flood')?.setData(this.overlayData.wpcFloodGeoJson || this._emptyFc());
    const watchFeats = (this.overlayData.spcWatchesGeoJson?.features || []).map((f) => {
      const p = f.properties || {};
      const isPds = Boolean(p.is_pds || String(p.pds || '').toUpperCase() === 'Y');
      const isTor = String(p.type || '').toUpperCase() === 'TOR';
      const watchColor = isPds ? '#ff00ff' : isTor ? '#ff1744' : '#ffb300';
      return { ...f, properties: { ...p, watchColor } };
    });
    this.map.getSource('tempest_watches')?.setData({ type: 'FeatureCollection', features: watchFeats });
    this.map.getSource('tempest_mcd')?.setData(this.overlayData.mcdGeoJson || this._emptyFc());
    this.map.getSource('tempest_lsr')?.setData(this.overlayData.lsrGeoJson || this._emptyFc());
  }

  _emptyFc() {
    return { type: 'FeatureCollection', features: [] };
  }
}

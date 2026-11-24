import {
  assert,
  assertEqual,
  describe,
  test
} from './test_framework.js';
import { RadarMapController } from '../js/radarMap.js';

function makeMockMapLib({ throwOnCreate = false } = {}) {
  const instances = [];
  class FakeSource {
    constructor(id, spec) { this.id = id; this.spec = spec; this.data = spec.data || null; }
    setData(d) { this.data = d; }
  }
  class FakeMap {
    constructor(opts) {
      if (throwOnCreate) throw new Error('WebGL context lost / unavailable');
      this.opts = opts;
      this.sources = new Map();
      this.layers = new Map();
      this.listeners = new Map();
      this.removed = false;
      this.canvas = document.createElement('canvas');
      instances.push(this);
    }
    on(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev).add(fn);
    }
    off(ev, fn) { this.listeners.get(ev)?.delete(fn); }
    emit(ev, data) {
      for (const fn of [...(this.listeners.get(ev) || [])]) fn(data);
    }
    getCanvas() { return this.canvas; }
    resize() { this.resizeCount = (this.resizeCount || 0) + 1; }
    flyTo() {}
    setStyle() { this.layers.clear(); this.sources.clear(); }
    addSource(id, spec) { this.sources.set(id, new FakeSource(id, spec)); }
    getSource(id) { return this.sources.get(id); }
    removeSource(id) { this.sources.delete(id); }
    addLayer(l) { this.layers.set(l.id, { ...l, paint: { ...(l.paint || {}) }, layout: { ...(l.layout || {}) } }); }
    getLayer(id) { return this.layers.get(id); }
    removeLayer(id) { this.layers.delete(id); }
    setPaintProperty(id, k, v) { if (this.layers.has(id)) this.layers.get(id).paint[k] = v; }
    setLayoutProperty(id, k, v) { if (this.layers.has(id)) this.layers.get(id).layout[k] = v; }
    queryRenderedFeatures() { return []; }
    remove() { this.removed = true; this.layers.clear(); this.sources.clear(); }
  }
  return { lib: { Map: FakeMap }, instances };
}

function makeFrames(product, count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${product}_${i}`,
    tileUrl: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${product}-${i}/{z}/{x}/{y}.png`,
    timestamp: new Date(Date.now() - (count - 1 - i) * 300000),
    label: `${product} #${i}`,
    feedLabel: 'Mock IEM'
  }));
}

describe('Radar Animation Loop, Lifecycle & Memory Leak Hardening (@pwa-engineer)', () => {
  test('Zero duplicate/zombie setInterval timers across rapid start/toggle/speed/product switches', () => {
    const origSet = window.setInterval;
    const origClear = window.clearInterval;
    const activeIntervals = new Set();
    window.setInterval = (...args) => {
      const id = origSet.apply(window, args);
      activeIntervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      activeIntervals.delete(id);
      return origClear.call(window, id);
    };

    const { lib, instances } = makeMockMapLib();
    const prevMapLibre = window.maplibregl;
    window.maplibregl = lib;

    try {
      const ctrl = new RadarMapController('radar-map-container');
      ctrl.init(34.6581, -88.5667);
      instances[0].emit('style.load', {});
      ctrl.setFrames(makeFrames('CONUS_MOSAIC', 6), 'CONUS_MOSAIC');

      // Rapid startPlayback & toggleSpeed calls must NEVER stack intervals
      ctrl.startPlayback();
      ctrl.startPlayback();
      ctrl.startPlayback();
      assertEqual(activeIntervals.size, 1, `Expected exactly 1 active interval after 3x startPlayback, got ${activeIntervals.size}`);

      ctrl.toggleSpeed();
      ctrl.toggleSpeed();
      assertEqual(activeIntervals.size, 1, `Expected 1 interval after rapid toggleSpeed, got ${activeIntervals.size}`);

      ctrl.stopPlayback();
      assertEqual(activeIntervals.size, 0, 'Expected 0 intervals after stopPlayback');

      // Rapid togglePlayback loop
      for (let i = 0; i < 10; i++) ctrl.togglePlayback();
      assertEqual(activeIntervals.size, 0, 'Even number of toggles leaves 0 intervals');

      ctrl.startPlayback();
      assertEqual(activeIntervals.size, 1, '1 active interval before destroy');
      assertEqual(typeof ctrl.destroy, 'function', 'destroy() method must exist');
      ctrl.destroy();
      assertEqual(activeIntervals.size, 0, 'destroy() must clear all intervals');
    } finally {
      window.setInterval = origSet;
      window.clearInterval = origClear;
      window.maplibregl = prevMapLibre;
    }
  });

  test('pauseForBackground / resumeFromBackground & visibilitychange cleanly pause and resume without zombie timers', () => {
    const origSet = window.setInterval;
    const origClear = window.clearInterval;
    const activeIntervals = new Set();
    window.setInterval = (...args) => {
      const id = origSet.apply(window, args);
      activeIntervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      activeIntervals.delete(id);
      return origClear.call(window, id);
    };

    const { lib, instances } = makeMockMapLib();
    const prevMapLibre = window.maplibregl;
    window.maplibregl = lib;

    try {
      const ctrl = new RadarMapController('radar-map-container');
      assertEqual(typeof ctrl.pauseForBackground, 'function', 'pauseForBackground() must exist');
      assertEqual(typeof ctrl.resumeFromBackground, 'function', 'resumeFromBackground() must exist');

      ctrl.init(34.6581, -88.5667);
      instances[0].emit('style.load', {});
      ctrl.setFrames(makeFrames('N0B', 6), 'N0B');

      // Case A: Playing before hide -> pause -> duplicate pause (idempotent!) -> resume restores playback with 1 timer
      ctrl.startPlayback();
      assertEqual(activeIntervals.size, 1, 'Playing before hide');
      ctrl.pauseForBackground();
      assertEqual(activeIntervals.size, 0, 'Paused on background');
      assertEqual(ctrl.playing, false, 'playing=false while backgrounded');
      // Duplicate call must NOT clobber wasPlayingBeforeHide
      ctrl.pauseForBackground();
      assertEqual(activeIntervals.size, 0, 'Still 0 after duplicate pauseForBackground');

      const resumed = ctrl.resumeFromBackground();
      assertEqual(resumed, true, 'resumeFromBackground must resume playback');
      assertEqual(ctrl.playing, true, 'playing=true after resume');
      assertEqual(activeIntervals.size, 1, 'Exactly 1 timer after resume');

      // Duplicate resume must remain 1 timer
      ctrl.resumeFromBackground();
      assertEqual(activeIntervals.size, 1, 'Duplicate resume keeps exactly 1 timer');

      // Case B: Paused before hide -> stays paused on resume
      ctrl.stopPlayback();
      ctrl.pauseForBackground();
      const resumedWhenPaused = ctrl.resumeFromBackground();
      assertEqual(resumedWhenPaused, false, 'Must stay paused if not playing before hide');
      assertEqual(activeIntervals.size, 0, '0 timers when resumed from paused state');

      // Case C: Real document visibilitychange event auto-pauses & auto-resumes via RadarMapController listener
      ctrl.startPlayback();
      assertEqual(activeIntervals.size, 1, 'Playing before visibilitychange');
      const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        assertEqual(activeIntervals.size, 0, 'visibilitychange hidden pauses timer');
        assertEqual(ctrl.playing, false, 'ctrl.playing=false while hidden');

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        assertEqual(activeIntervals.size, 1, 'visibilitychange visible resumes with exactly 1 timer');
        assertEqual(ctrl.playing, true, 'ctrl.playing=true after visible');
      } finally {
        if (hiddenDesc) {
          Object.defineProperty(document, 'hidden', hiddenDesc);
        } else {
          delete document.hidden;
        }
      }

      ctrl.destroy();
    } finally {
      window.setInterval = origSet;
      window.clearInterval = origClear;
      window.maplibregl = prevMapLibre;
    }
  });

  test('Switching products cleans stale radar layers/sources (no GPU/memory leak) & handles WebGL/map errors gracefully', () => {
    const { lib, instances } = makeMockMapLib();
    const prevMapLibre = window.maplibregl;
    window.maplibregl = lib;

    try {
      let reportedErrors = 0;
      const ctrl = new RadarMapController('radar-map-container', {
        onError: () => { reportedErrors += 1; }
      });
      ctrl.init(34.6581, -88.5667);
      const map = instances[0];
      map.emit('style.load', {});

      // Switch across 5 products of varying frame counts (including > 20 frames -> e.g. 24 then 4!)
      const counts = [10, 24, 6, 12, 4];
      for (let i = 0; i < counts.length; i++) {
        ctrl.setFrames(makeFrames(`PROD_${i}`, counts[i]), `PROD_${i}`);
      }
      const radarLayers = [...map.layers.keys()].filter((k) => k.startsWith('tempest_radar_lyr_'));
      const radarSources = [...map.sources.keys()].filter((k) => k.startsWith('tempest_radar_src_'));
      assertEqual(radarLayers.length, 4, `Expected exactly 4 radar layers after switching from 24->4 frames, got ${radarLayers.length}`);
      assertEqual(radarSources.length, 4, `Expected exactly 4 radar sources after switching from 24->4 frames, got ${radarSources.length}`);

      // Map tile/WebGL error event must NOT throw uncaught exception
      map.emit('error', { error: new Error('Tile 503 failed') });
      // Click with absent layers & malformed storm cell data must NOT throw
      map.emit('click', { point: { x: 10, y: 10 }, lngLat: { lng: -88.5, lat: 34.6 } });
      ctrl.setOverlayData({
        stormCells: [{ id: 'bad_cell', lat: NaN, lon: -88.5, intercept: null }],
        alerts: [{ id: 'a1', event: 'Test', geometry: null }]
      });
      ctrl.destroy();
      assertEqual(map.removed, true, 'destroy() called map.remove()');

      // Missing WebGL / maplibregl.Map throwing on init must be caught cleanly!
      const failing = makeMockMapLib({ throwOnCreate: true });
      window.maplibregl = failing.lib;
      const ctrl2 = new RadarMapController('radar-map-container');
      ctrl2.init(34.6581, -88.5667);
      assertEqual(ctrl2.ready, false, 'Failed WebGL init leaves ready=false cleanly without throwing');
      ctrl2.destroy();
    } finally {
      window.maplibregl = prevMapLibre;
    }
  });

  test('iOS Safari BFCache pagehide / pageshow (persisted=true) pauses and resumes with zero zombie intervals', async () => {
    const origSet = window.setInterval;
    const origClear = window.clearInterval;
    const activeIntervals = new Set();
    window.setInterval = (...args) => {
      const id = origSet.apply(window, args);
      activeIntervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      activeIntervals.delete(id);
      return origClear.call(window, id);
    };

    const { lib, instances } = makeMockMapLib();
    const prevMapLibre = window.maplibregl;
    window.maplibregl = lib;

    try {
      const ctrl = new RadarMapController('radar-map-container');
      ctrl.init(34.6581, -88.5667);
      instances[0].emit('style.load', {});
      ctrl.setFrames(makeFrames('N0B', 6), 'N0B');

      ctrl.startPlayback();
      assertEqual(activeIntervals.size, 1, '1 interval before pagehide');

      const makePageEvent = (type, persisted) => {
        if (typeof PageTransitionEvent === 'function') {
          return new PageTransitionEvent(type, { persisted });
        }
        const ev = new Event(type);
        Object.defineProperty(ev, 'persisted', { value: persisted });
        return ev;
      };

      // Simulate iOS Safari app-switcher BFCache suspend -> restore twice
      const mapInst = instances[0];
      const resizesBefore = mapInst.resizeCount || 0;
      for (let cycle = 0; cycle < 2; cycle++) {
        window.dispatchEvent(makePageEvent('pagehide', true));
        assertEqual(activeIntervals.size, 0, `Cycle ${cycle}: pagehide must clear animation interval`);
        window.dispatchEvent(makePageEvent('pageshow', true));
        assertEqual(activeIntervals.size, 1, `Cycle ${cycle}: pageshow(persisted=true) must resume strictly 1 interval`);
        await new Promise((r) => setTimeout(r, 60));
      }
      assert((mapInst.resizeCount || 0) >= resizesBefore + 2, 'Regression #41-6: pageshow(persisted=true) must trigger map.resize()');

      // Regression #41-6: invalid user coordinates & post-destroy webglcontextrestored must never throw
      ctrl.setUserLocation(NaN, -88.5);
      ctrl.destroy();
      assertEqual(activeIntervals.size, 0, 'destroy clears interval after BFCache cycles');
      mapInst.getCanvas().dispatchEvent(new Event('webglcontextrestored'));
    } finally {
      window.setInterval = origSet;
      window.clearInterval = origClear;
      window.maplibregl = prevMapLibre;
    }
  });

  test('Interactive Radar Weather-System Click Inspection (#42/#43): all 8 system types, priority & multi-system collection', () => {
    const { lib, instances } = makeMockMapLib();
    const prevMapLibre = window.maplibregl;
    window.maplibregl = lib;

    try {
      const fired = [];
      const ctrl = new RadarMapController('radar-map-container', {
        onInspectCell: (item, ctx) => fired.push({ type: 'cell', item, ctx }),
        onInspectLsr: (item, ctx) => fired.push({ type: 'lsr', item, ctx }),
        onInspectAlert: (item, ctx) => fired.push({ type: 'alert', item, ctx }),
        onInspectWatch: (item, ctx) => fired.push({ type: 'watch', item, ctx }),
        onInspectMcd: (item, ctx) => fired.push({ type: 'mcd', item, ctx }),
        onInspectWpc: (item, ctx) => fired.push({ type: 'wpc', item, ctx }),
        onInspectOutlook: (item, ctx) => fired.push({ type: 'outlook', item, ctx }),
        onInspectPoint: (ctx) => fired.push({ type: 'point', ctx })
      });
      ctrl.init(34.6581, -88.5667);
      instances[0].emit('style.load', {});
      ctrl.setFrames(makeFrames('N0B', 4), 'N0B');
      ctrl.setLayerVisibility('flood', true);

      const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
      ctrl.setOverlayData({
        stormCells: [{ id: 'KGWX_K4', stormId: 'K4', lat: 34.60, lon: -88.62, maxDbz: 66, tvs: 'TVS', threatScore: 4 }],
        lsrGeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-88.48, 34.72] }, properties: { typetext: 'TORNADO' } }]
        },
        alerts: [{ id: 'tor-1', event: 'Tornado Warning', tier: 'CRITICAL', rank: 100, geometry: box(-88.75, 34.55, -88.40, 34.78) }],
        spcWatchesGeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: box(-89.0, 34.3, -88.0, 35.0), properties: { num: 412, type: 'TOR', is_pds: true } }]
        },
        mcdGeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: box(-89.2, 34.1, -87.8, 35.1), properties: { num: 1984 } }]
        },
        wpcFloodGeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: box(-89.4, 33.9, -87.6, 35.2), properties: { OUTLOOK: 'ENH' } }]
        },
        spcDay1GeoJson: {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: box(-89.6, 33.7, -87.4, 35.4), properties: { LABEL: 'MDT' } }]
        }
      });

      // 1. Tap Storm Cell -> resolves 'cell' AND collects overlapping alert/watch/mcd/flood/outlook!
      const rCell = ctrl.inspectAtPoint(34.60, -88.62);
      assertEqual(rCell.type, 'cell', 'Direct cell tap must resolve type=cell');
      assertEqual(rCell.context.systems.alerts.length, 1, 'Overlapping alert collected');
      assertEqual(rCell.context.systems.watches.length, 1, 'Overlapping watch collected');
      assertEqual(rCell.context.systems.mcds.length, 1, 'Overlapping MCD collected');
      assertEqual(rCell.context.systems.floods.length, 1, 'Overlapping WPC flood collected');
      assertEqual(rCell.context.systems.outlooks.length, 1, 'Overlapping SPC outlook collected');

      // 2. Tap LSR (away from cell) -> resolves 'lsr'
      assertEqual(ctrl.inspectAtPoint(34.72, -88.48).type, 'lsr', 'Direct LSR tap must resolve type=lsr');

      // 3. Tap inside Warning (away from cell/LSR) -> resolves 'alert'
      assertEqual(ctrl.inspectAtPoint(34.68, -88.68).type, 'alert', 'Warning polygon tap must resolve type=alert');

      // 4. Tap inside Watch (outside Warning) -> resolves 'watch'
      assertEqual(ctrl.inspectAtPoint(34.40, -88.90).type, 'watch', 'Watch-only polygon tap must resolve type=watch');

      // 5. Tap inside MCD (outside Watch) -> resolves 'mcd'
      assertEqual(ctrl.inspectAtPoint(34.20, -89.10).type, 'mcd', 'MCD-only polygon tap must resolve type=mcd');

      // 6. Tap inside WPC Flood ERO (outside MCD) -> resolves 'wpc'
      assertEqual(ctrl.inspectAtPoint(34.00, -89.30).type, 'wpc', 'WPC-only polygon tap must resolve type=wpc');

      // 7. Tap inside SPC Outlook (outside WPC) -> resolves 'outlook'
      assertEqual(ctrl.inspectAtPoint(33.80, -89.50).type, 'outlook', 'SPC-only polygon tap must resolve type=outlook');

      // 8. Tap Open Map (outside ALL overlays) -> resolves 'point' fallback with nearestCell metadata!
      const rOpen = ctrl.inspectAtPoint(32.50, -86.00);
      assertEqual(rOpen.type, 'point', 'Open-map tap outside all polygons must resolve type=point');
      assertEqual(rOpen.context.systems.nearestCell.id, 'KGWX_K4', 'Open-map point context includes nearest tracked storm cell');

      // 9. NaN coordinates never throw and fall back safely to userLoc
      const rNan = ctrl.inspectAtPoint(NaN, undefined);
      assert(Boolean(rNan && rNan.type), 'NaN coordinates handled cleanly without throwing');

      assertEqual(fired.length, 9, `All 9 inspect callbacks fired cleanly, got ${fired.length}`);
      ctrl.destroy();
    } finally {
      window.maplibregl = prevMapLibre;
    }
  });
});

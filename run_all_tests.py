r"""
Master Adversarial Verification Runner for Borden Tempest Weather PWA.
Runs inside real headless Chromium via CDP with 100% mocked external network
(zero live calls to AWS S3, IEM, Open-Meteo, NWS, SPC, WPC, or CDNs).

Usage:
    C:\Users\jamie\miniconda3\python.exe tests/run_all_tests.py
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Tuple

TESTS_DIR = Path(__file__).resolve().parent
APP_ROOT = TESTS_DIR.parent
ARTIFACT_DIR = Path(r"C:\Users\jamie\.gemini\antigravity\brain\486ac362-a3b8-4367-b9d9-8d712da3fcbb")

sys.path.insert(0, str(TESTS_DIR))
from cdp_harness import CDPBrowser, LocalAppServer  # noqa: E402
from mock_fixtures import MockWeatherRouter  # noqa: E402


class VerificationReport:
    def __init__(self) -> None:
        self.checks: List[Dict[str, Any]] = []
        self.screenshots: List[Tuple[str, str]] = []

    def record(self, suite: str, name: str, passed: bool, detail: str = "") -> None:
        self.checks.append({
            "suite": suite,
            "name": name,
            "passed": bool(passed),
            "detail": detail,
        })
        tag = "PASS" if passed else "FAIL"
        suffix = f" -- {detail}" if detail else ""
        print(f"[{tag}] [{suite}] {name}{suffix}", flush=True)

    def add_screenshot(self, path: Path, caption: str) -> None:
        self.screenshots.append((str(path), caption))

    @property
    def failed_checks(self) -> List[Dict[str, Any]]:
        return [c for c in self.checks if not c["passed"]]


def wait_until(fn, timeout_s: float = 10.0, interval_s: float = 0.15):
    deadline = time.time() + timeout_s
    last_val = None
    while time.time() < deadline:
        last_val = fn()
        if last_val:
            return last_val
        time.sleep(interval_s)
    return last_val


def run_suite_a_unit_tests(report: VerificationReport, base_url: str) -> None:
    """Suite A: Real Chrome V8 ES Module Unit & Adversarial Logic Tests."""
    router = MockWeatherRouter(scenario="strict_block")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=1280, height=800)
        # Override browser timezone to Pacific/Honolulu (UTC-10) so America/Chicago tests MUST not rely on host TZ!
        browser.set_timezone(sid, "Pacific/Honolulu")
        browser.navigate(sid, f"{base_url}/tests/unit_runner.html")

        ready = wait_until(lambda: browser.evaluate(sid, "Boolean(window.__UNIT_RUNNER_READY__)"), timeout_s=10.0)
        if not ready:
            errs = browser.console_errors + browser.exceptions
            report.record("A:Unit", "Load unit_runner.html ES modules", False, f"Runner did not initialize. Errors: {errs}")
            return

        res = browser.evaluate(sid, "window.__RUN_UNIT_TESTS__()", await_promise=True, timeout=60.0)
        for item in res.get("results", []):
            report.record(
                f"A:Unit:{item['group']}",
                item["name"],
                item["passed"],
                "" if item["passed"] else item.get("error", "failed"),
            )

        # Strict leakage / runtime gates for Suite A
        report.record(
            "A:Gate",
            "Zero live network leakage in unit tests",
            len(browser.leakage_violations) == 0 and len(res.get("liveNetworkLeaks", [])) == 0,
            "" if not browser.leakage_violations else json.dumps(browser.leakage_violations[:3]),
        )
        report.record(
            "A:Gate",
            "Zero uncaught exceptions / unhandled rejections / console errors in unit tests",
            len(browser.exceptions) == 0 and len(browser.console_errors) == 0 and len(res.get("unhandledRejections", [])) == 0,
            "" if (not browser.exceptions and not browser.console_errors) else json.dumps({
                "exceptions": browser.exceptions[:3],
                "console_errors": browser.console_errors[:3],
                "unhandledRejections": res.get("unhandledRejections", [])[:3],
            }),
        )
    finally:
        browser.close()


def run_suite_b_service_worker(report: VerificationReport, base_url: str, server: LocalAppServer) -> None:
    """Suite B: Real Service Worker registration, static shell caching, strict live-API never-cache & manifest check."""
    server.set_override("/api/live-check", 200, "application/json", b'{"live":true}')
    server.set_override("/sample-radar.geojson", 200, "application/geo+json", b'{"type":"FeatureCollection","features":[]}')
    server.set_override("/tilecache/layer/1.png", 200, "image/png", b"\x89PNG\r\n\x1a\n")
    server.set_override("/wms/radar", 200, "image/png", b"\x89PNG\r\n\x1a\n")
    server.set_override("/ridge/KGWX/0.png", 200, "image/png", b"\x89PNG\r\n\x1a\n")
    server.set_override("/alerts/feed", 200, "application/json", b'{"alerts":[]}')
    server.set_override("/observations/latest", 200, "application/json", b'{"obs":[]}')
    server.set_override("/forecasts/daily", 200, "application/json", b'{"periods":[]}')
    server.set_override("/data/feed", 200, "application/json", b'{"ok":true}')
    # Check manifest.webmanifest first
    try:
        manifest_path = APP_ROOT / "manifest.webmanifest"
        mdata = json.loads(manifest_path.read_text(encoding="utf-8"))
        icons_ok = all((APP_ROOT / ic["src"].lstrip("./")).is_file() for ic in mdata.get("icons", []))
        manifest_ok = (
            bool(mdata.get("name"))
            and bool(mdata.get("short_name"))
            and bool(mdata.get("start_url"))
            and bool(mdata.get("scope"))
            and mdata.get("display") in ("standalone", "fullscreen", "minimal-ui")
            and bool(mdata.get("theme_color"))
            and bool(mdata.get("background_color"))
            and len(mdata.get("icons", [])) >= 2
            and icons_ok
        )
        report.record("B:PWA", "manifest.webmanifest schema & icon files valid", manifest_ok, "" if manifest_ok else str(mdata))
    except Exception as exc:
        report.record("B:PWA", "manifest.webmanifest schema & icon files valid", False, str(exc))

    # Check v1.6.1 version consistency across version.json, sw.js, and js/updater.js + iOS PWA meta tags & safe-area CSS
    try:
        vjson = json.loads((APP_ROOT / "version.json").read_text(encoding="utf-8"))
        sw_txt = (APP_ROOT / "sw.js").read_text(encoding="utf-8")
        upd_txt = (APP_ROOT / "js" / "updater.js").read_text(encoding="utf-8")
        html_txt = (APP_ROOT / "index.html").read_text(encoding="utf-8")
        css_txt = (APP_ROOT / "css" / "styles.css").read_text(encoding="utf-8")

        ver_ok = (
            vjson.get("versionCode") == 8
            and vjson.get("versionName") == "1.6.1"
            and "borden-tempest-v1.6.1-b8" in sw_txt
            and "versionCode: 8" in upd_txt
            and "1.6.1" in upd_txt
        )
        report.record(
            "B:PWA",
            "Version consistency v1.6.1 / versionCode=8 / borden-tempest-v1.6.1-b8 across version.json, sw.js & updater.js",
            ver_ok,
            f"version.json={vjson.get('versionName')}/b{vjson.get('versionCode')}",
        )

        ios_meta_ok = (
            "viewport-fit=cover" in html_txt
            and 'name="apple-mobile-web-app-capable"' in html_txt
            and 'name="apple-mobile-web-app-status-bar-style"' in html_txt
            and 'rel="apple-touch-icon"' in html_txt
            and ('content="#040811"' in html_txt or 'content="#050912"' in html_txt)
        )
        report.record(
            "B:PWA",
            "index.html contains required iOS standalone PWA meta tags & obsidian theme-color",
            ios_meta_ok,
        )

        safe_area_css_ok = (
            "safe-area-inset-top" in css_txt
            and "safe-area-inset-bottom" in css_txt
            and "safe-area-inset-left" in css_txt
            and "safe-area-inset-right" in css_txt
            and ("100dvh" in css_txt or "-webkit-fill-available" in css_txt)
        )
        report.record(
            "B:PWA",
            "styles.css configures all 4 iOS safe-area-insets & dynamic viewport height (100dvh/-webkit-fill-available)",
            safe_area_css_ok,
        )
    except Exception as exc:
        report.record("B:PWA", "iOS PWA version/meta/safe-area static audit", False, str(exc))

    router = MockWeatherRouter(scenario="clear")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=1280, height=800)
        browser.navigate(sid, f"{base_url}/")

        # Pre-seed legacy caches to prove sw.js activate purges stale caches cleanly
        browser.evaluate(sid, """
        (async () => {
          const old1 = await caches.open('borden-tempest-v1.5.0-b6');
          await old1.put(new Request('/legacy-stale.txt'), new Response('stale'));
          const old2 = await caches.open('borden-tempest-v1.6.0-b7');
          await old2.put(new Request('/legacy-v160.txt'), new Response('stale'));
        })()
        """, await_promise=True)

        # Wait for SW registration & full activation (transitioning past 'activating' -> 'activated')
        sw_state = browser.evaluate(sid, """
        (async () => {
          if (!('serviceWorker' in navigator)) return { supported: false };
          const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
          const ready = await navigator.serviceWorker.ready;
          const worker = ready.active || reg.active || reg.installing || reg.waiting;
          if (worker && worker.state !== 'activated') {
            await new Promise((resolve) => {
              const onChange = () => {
                if (worker.state === 'activated' || worker.state === 'redundant') {
                  worker.removeEventListener('statechange', onChange);
                  resolve();
                }
              };
              worker.addEventListener('statechange', onChange);
              setTimeout(resolve, 4000);
            });
          }
          return {
            supported: true,
            scope: reg.scope,
            activeState: ready.active ? ready.active.state : null,
            scriptURL: ready.active ? ready.active.scriptURL : null
          };
        })()
        """, await_promise=True)
        sw_ok = bool(sw_state and sw_state.get("supported") and sw_state.get("activeState") == "activated")
        report.record("B:SW", "Service Worker registers & activates cleanly", sw_ok, json.dumps(sw_state))

        # Reload so SW actively controls the page (navigator.serviceWorker.controller != null)
        browser.navigate(sid, f"{base_url}/")
        time.sleep(1.0)
        controlled = browser.evaluate(sid, "Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)")
        report.record("B:SW", "Service Worker controls page after reload", bool(controlled), f"controller={controlled}")

        # Verify static shell is cached
        cache_info = browser.evaluate(sid, """
        (async () => {
          const keys = await caches.keys();
          const urls = [];
          for (const k of keys) {
            const c = await caches.open(k);
            const reqs = await c.keys();
            reqs.forEach(r => urls.push(r.url));
          }
          return { keys, count: urls.length, sample: urls.slice(0, 10), allUrls: urls };
        })()
        """, await_promise=True)
        all_cached_urls = cache_info.get("allUrls", [])
        legacy_purged = (
            "borden-tempest-v1.5.0-b6" not in cache_info.get("keys", [])
            and "borden-tempest-v1.6.0-b7" not in cache_info.get("keys", [])
        )
        report.record(
            "B:SW",
            "SW activate purges legacy caches (v1.5.0-b6 & v1.6.0-b7)",
            legacy_purged,
            f"keys={cache_info.get('keys')}",
        )
        shell_cached = (
            len(cache_info.get("keys", [])) >= 1
            and any(u.endswith("/index.html") or u.endswith("/") for u in all_cached_urls)
            and any(u.endswith("/css/styles.css") for u in all_cached_urls)
            and any(u.endswith("/js/app.js") for u in all_cached_urls)
            and any(u.endswith("/js/nexradStations.js") for u in all_cached_urls)
            and any(u.endswith("/js/radarMap.js") for u in all_cached_urls)
        )
        report.record(
            "B:SW",
            "Static app shell cached in versioned CacheStorage",
            shell_cached,
            f"caches={cache_info.get('keys')} entries={cache_info.get('count')}",
        )

        # Fetch live weather/radar/S3/NWS/Open-Meteo/version.json + edge-case regional S3 & query URLs -> MUST NEVER BE CACHED
        live_urls = [
            "https://api.weather.gov/alerts/active?point=34.6581,-88.5667",
            "https://api.open-meteo.com/v1/forecast?latitude=34.6581&longitude=-88.5667",
            "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/5/8/12.png",
            "https://unidata-nexrad-level3.s3.amazonaws.com/KGWX/N0B_test.bin",
            "https://unidata-nexrad-level3.s3.us-east-1.amazonaws.com/KGWX/N0B_regional.bin?v=1",
            "https://radar.weather.gov/ridge/standard/KGWX_0.png?t=99",
            "https://tilecache.rainviewer.com/v2/radar/12345/256/5/8/12/2/1_1.png",
            "https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl?dir=test",
            f"{base_url}/version.json",
            f"{base_url}/version.json?cb=99999",
            f"{base_url}/api/live-check",
            f"{base_url}/sample-radar.geojson",
            f"{base_url}/sample-radar.geojson?ts=12345",
            f"{base_url}/tilecache/layer/1.png",
            f"{base_url}/wms/radar?service=wms",
            f"{base_url}/ridge/KGWX/0.png",
            f"{base_url}/alerts/feed",
            f"{base_url}/observations/latest",
            f"{base_url}/forecasts/daily",
            f"{base_url}/data/feed?f=geojson",
            f"{base_url}/data/feed?format=json",
            f"{base_url}/sw.js",
        ]
        never_cache_check = browser.evaluate(sid, f"""
        (async () => {{
          const urls = {json.dumps(live_urls)};
          const statuses = {{}};
          for (const u of urls) {{
            try {{
              const r = await fetch(u);
              statuses[u] = r.status;
            }} catch (e) {{
              statuses[u] = 'ERR:' + e.message;
            }}
          }}
          const leakedIntoCache = [];
          const keys = await caches.keys();
          for (const k of keys) {{
            const c = await caches.open(k);
            for (const u of urls) {{
              const m = await c.match(u);
              if (m) leakedIntoCache.push({{ cache: k, url: u }});
            }}
            const reqs = await c.keys();
            for (const r of reqs) {{
              if (
                r.url.includes('api.weather.gov') ||
                r.url.includes('radar.weather.gov') ||
                r.url.includes('nomads.ncep.noaa.gov') ||
                r.url.includes('rainviewer.com') ||
                r.url.includes('open-meteo.com') ||
                r.url.includes('mesonet.agron.iastate.edu') ||
                r.url.includes('amazonaws.com') ||
                r.url.includes('version.json') ||
                r.url.includes('/api/') ||
                r.url.includes('.geojson') ||
                r.url.includes('/tilecache/') ||
                r.url.includes('/wms/') ||
                r.url.includes('/ridge/') ||
                r.url.includes('/alerts/') ||
                r.url.includes('/observations/') ||
                r.url.includes('/forecasts/') ||
                r.url.includes('/data/feed') ||
                r.url.endsWith('/sw.js')
              ) {{
                leakedIntoCache.push({{ cache: k, url: r.url }});
              }}
            }}
          }}
          return {{ statuses, leakedIntoCache }};
        }})()
        """, await_promise=True)
        no_live_cached = len(never_cache_check.get("leakedIntoCache", [])) == 0
        report.record(
            "B:SW",
            "Regression #41-1: Live NWS/Open-Meteo/IEM/S3/NOAA/RainViewer/tilecache/wms/ridge/alerts/query-geojson/sw.js NEVER cached",
            no_live_cached,
            "" if no_live_cached else json.dumps(never_cache_check["leakedIntoCache"]),
        )

        # Now drop network (offline_503) and re-fetch live weather URLs -> must NEVER return stale 200 OK
        router.set_scenario("offline_503")
        offline_check = browser.evaluate(sid, """
        (async () => {
          const urls = [
            'https://api.weather.gov/alerts/active?point=34.6581,-88.5667',
            'https://api.open-meteo.com/v1/forecast?latitude=34.6581&longitude=-88.5667',
            'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/5/8/12.png',
            'https://unidata-nexrad-level3.s3.amazonaws.com/KGWX/N0B_test.bin'
          ];
          const out = {};
          for (const u of urls) {
            try {
              const r = await fetch(u);
              out[u] = { ok: r.ok, status: r.status };
            } catch (e) {
              out[u] = { ok: false, threw: e.message };
            }
          }
          return out;
        })()
        """, await_promise=True)
        no_stale_200 = all(not v.get("ok") for v in offline_check.values())
        report.record(
            "B:SW",
            "Offline / 503 live endpoints never serve stale cached 200 OK weather data",
            no_stale_200,
            json.dumps(offline_check),
        )

        report.record(
            "B:SW",
            "Zero SW/page uncaught exceptions & zero live network leakage",
            len(browser.exceptions) == 0 and len(browser.leakage_violations) == 0,
            "" if (not browser.exceptions and not browser.leakage_violations) else json.dumps({
                "exceptions": browser.exceptions[:3],
                "leaks": browser.leakage_violations[:3],
            }),
        )
    finally:
        browser.close()


def wait_for_app_synced(browser: CDPBrowser, sid: str, timeout_s: float = 12.0) -> bool:
    return bool(wait_until(
        lambda: browser.evaluate(
            sid,
            """
            (() => {
              const loc = document.getElementById('header-location-name')?.textContent || '';
              const sub = document.getElementById('header-status-sub')?.textContent || '';
              const skel = document.querySelector('#dashboard-content .skeleton-card');
              return loc.includes('Booneville') && !skel && (sub.includes('Updated') || sub.includes('Offline'));
            })()
            """,
        ),
        timeout_s=timeout_s,
    ))


def check_viewport_layout(
    browser: CDPBrowser,
    sid: str,
    width: int,
    height: int,
    mobile: bool,
    label: str,
    screenshot_name: str,
    report: VerificationReport,
) -> None:
    browser.set_viewport(sid, width, height, mobile=mobile, device_scale=2.0 if mobile else 1.0)
    time.sleep(0.35)
    # Check overflow across all 4 tabs
    overflow_issues = []
    for tab in ("dashboard", "alerts", "settings", "radar"):
        browser.evaluate(sid, f"document.querySelector('.tab-btn[data-tab=\"{tab}\"]')?.click()")
        time.sleep(0.35)
        metrics = browser.evaluate(sid, """
        (() => {
          const sw = document.documentElement.scrollWidth;
          const iw = window.innerWidth;
          const bw = document.body ? document.body.scrollWidth : iw;
          return { scrollWidth: sw, bodyScrollWidth: bw, innerWidth: iw };
        })()
        """)
        if metrics["scrollWidth"] > metrics["innerWidth"] + 1 or metrics["bodyScrollWidth"] > metrics["innerWidth"] + 1:
            overflow_issues.append({tab: metrics})

    # Return to dashboard for screenshot & touch target audit
    browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"dashboard\"]')?.click()")
    time.sleep(0.35)

    report.record(
        f"C1:Viewport:{label}",
        f"Zero horizontal overflow across all 4 tabs at {width}x{height}",
        len(overflow_issues) == 0,
        "" if not overflow_issues else json.dumps(overflow_issues),
    )

    if mobile:
        touch_issues = browser.evaluate(sid, """
        (() => {
          const selectors = ['.tab-btn', '#btn-gps', '#btn-refresh'];
          const bad = [];
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return;
              if (r.height < 40 || r.width < 40) {
                bad.push({ sel, text: (el.textContent || el.id || '').trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) });
              }
            });
          }
          return bad;
        })()
        """)
        report.record(
            f"C1:Viewport:{label}",
            f"Primary mobile touch targets >= 40px at {width}x{height}",
            len(touch_issues) == 0,
            "" if not touch_issues else json.dumps(touch_issues),
        )

    shot_path = ARTIFACT_DIR / screenshot_name
    browser.screenshot(sid, shot_path, full_page=False)
    report.add_screenshot(shot_path, f"Headless {label} {width}x{height} verified clear dashboard")


def run_suite_c_e2e(report: VerificationReport, base_url: str) -> None:
    """Suite C: Full Live App E2E Scenarios in Headless Chrome."""

    # --- C1: Clear Baseline + Desktop & Mobile Viewports + Zero Console Errors ---
    router = MockWeatherRouter(scenario="clear")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=1280, height=800, mobile=False)
        browser.navigate(sid, f"{base_url}/")
        synced = wait_for_app_synced(browser, sid)
        report.record("C1:Clear", "App boots & renders mocked live weather without errors", synced)

        # Fresh data (<15m) -> #data-staleness-banner MUST exist and remain HIDDEN
        banner_state = browser.evaluate(sid, """
        (() => {
          const el = document.getElementById('data-staleness-banner');
          if (!el) return { exists: false };
          const cs = getComputedStyle(el);
          return {
            exists: true,
            hiddenAttr: el.hidden,
            hasHiddenClass: el.classList.contains('hidden'),
            display: cs.display,
            visible: cs.display !== 'none' && !el.hidden && !el.classList.contains('hidden')
          };
        })()
        """)
        report.record(
            "C1:Clear",
            "#data-staleness-banner exists and is HIDDEN on fresh (<15m) feeds",
            bool(banner_state.get("exists") and not banner_state.get("visible")),
            json.dumps(banner_state),
        )

        # Check Desktop 1280x800, Mobile 430x932 (Pro Max), Mobile 390x844, Mobile 375x812 & Landscape 844x390 + screenshots
        check_viewport_layout(browser, sid, 1280, 800, False, "Desktop", "tempest_desktop_1280x800.png", report)
        check_viewport_layout(browser, sid, 430, 932, True, "Mobile430", "tempest_mobile_430x932.png", report)
        check_viewport_layout(browser, sid, 390, 844, True, "Mobile390", "tempest_mobile_390x844.png", report)
        check_viewport_layout(browser, sid, 375, 812, True, "Mobile375", "tempest_mobile_375x812.png", report)

        # Regression #41-8: iOS auto-zoom guard (>=16px search input) & .btn-glass-* >= 44px touch targets on 375x812
        browser.evaluate(sid, "document.getElementById('location-picker-trigger')?.click()")
        time.sleep(0.25)
        ios_css_metrics = browser.evaluate(sid, """
        (() => {
          const inp = document.querySelector('.modal-search-row input');
          const inpFont = inp ? parseFloat(getComputedStyle(inp).fontSize) : 0;
          document.getElementById('btn-close-location-modal')?.click();
          document.querySelector('.tab-btn[data-tab="settings"]')?.click();
          const glassBtns = [...document.querySelectorAll('.btn-glass-primary, .btn-glass-secondary, .btn-glass-danger, .btn-glass-accent, .btn-glass-indigo')]
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { text: (el.textContent || '').trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height), clipped: r.right > window.innerWidth + 1 };
            })
            .filter((b) => b.w > 0 && b.h > 0);
          return { inpFont, glassCount: glassBtns.length, badGlass: glassBtns.filter((b) => b.h < 44 || b.clipped) };
        })()
        """)
        css_41_ok = ios_css_metrics["inpFont"] >= 16.0 and ios_css_metrics["glassCount"] > 0 and len(ios_css_metrics["badGlass"]) == 0
        report.record(
            "C1:Viewport:Mobile375",
            "Regression #41-8: iOS search input >=16px (no auto-zoom) & .btn-glass-* >=44px zero clipping on 375x812",
            css_41_ok,
            json.dumps(ios_css_metrics),
        )

        check_viewport_layout(browser, sid, 844, 390, True, "MobileLandscape", "tempest_mobile_landscape_844x390.png", report)

        report.record(
            "C1:Clear",
            "Zero console errors, uncaught exceptions, or live network leaks during full E2E",
            len(browser.console_errors) == 0 and len(browser.exceptions) == 0 and len(browser.leakage_violations) == 0,
            "" if (not browser.console_errors and not browser.exceptions and not browser.leakage_violations) else json.dumps({
                "console_errors": browser.console_errors[:3],
                "exceptions": browser.exceptions[:3],
                "leaks": browser.leakage_violations[:3],
            }),
        )
    finally:
        browser.close()

    # --- C2: Hard >15-Minute Staleness Banner DOM Gate (Open-Meteo stale + Radar stale + Recovery) ---
    router = MockWeatherRouter(scenario="stale_open_meteo")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True, device_scale=2.0)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)
        time.sleep(0.5)

        stale_om_dom = browser.evaluate(sid, """
        (() => {
          const el = document.getElementById('data-staleness-banner');
          if (!el) return { exists: false };
          const cs = getComputedStyle(el);
          return {
            exists: true,
            visible: cs.display !== 'none' && !el.hidden && !el.classList.contains('hidden'),
            text: (el.textContent || '').trim()
          };
        })()
        """)
        report.record(
            "C2:Staleness",
            "Stale Open-Meteo (>15m) renders #data-staleness-banner VISIBLE in live DOM",
            bool(stale_om_dom.get("exists") and stale_om_dom.get("visible")),
            json.dumps(stale_om_dom),
        )
        if stale_om_dom.get("visible"):
            shot_stale = ARTIFACT_DIR / "tempest_mobile_stale_banner.png"
            browser.screenshot(sid, shot_stale, full_page=False)
            report.add_screenshot(shot_stale, "Mobile staleness warning banner visible for >15m data")

        # Recovery to fresh clears banner
        router.set_scenario("clear")
        browser.evaluate(sid, "(document.getElementById('btn-staleness-refresh') || document.getElementById('btn-refresh'))?.click()")
        cleared = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const el = document.getElementById('data-staleness-banner');
              return el && (el.hidden || el.classList.contains('hidden') || getComputedStyle(el).display === 'none');
            })()
            """),
            timeout_s=8.0,
        )
        report.record("C2:Staleness", "Refreshing fresh (<15m) data hides #data-staleness-banner", bool(cleared))

        # Now test Stale Radar (>15m) with single-site NEXRAD N0B product!
        router.set_scenario("stale_radar")
        browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"radar\"]')?.click()")
        time.sleep(0.4)
        browser.evaluate(sid, "document.querySelector('#radar-product-chips .radar-chip[data-product=\"N0B\"]')?.click()")
        stale_radar_vis = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const el = document.getElementById('data-staleness-banner');
              if (!el) return false;
              const cs = getComputedStyle(el);
              return cs.display !== 'none' && !el.hidden && !el.classList.contains('hidden');
            })()
            """),
            timeout_s=8.0,
        )
        report.record(
            "C2:Staleness",
            "Stale NEXRAD radar frame (>15m) renders #data-staleness-banner VISIBLE in live DOM",
            bool(stale_radar_vis),
        )
    finally:
        browser.close()

    # --- C3: Synthetic Tornado Warning Polygon Lifecycle (Fire Once, Dedup, Immediate Purge on Expiry) ---
    router = MockWeatherRouter(scenario="tornado_active")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True, device_scale=2.0)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)

        popup_shown = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const m = document.getElementById('alert-popup-modal');
              if (!m || m.classList.contains('hidden')) return null;
              return {
                title: document.getElementById('alert-popup-title')?.textContent || '',
                badge: document.getElementById('alert-popup-badge')?.textContent || '',
                body: document.getElementById('alert-popup-body')?.textContent || '',
                ribbonCritical: document.getElementById('telemetry-ribbon')?.classList.contains('tone-critical') || false,
                badgeCount: document.getElementById('alerts-badge')?.textContent || ''
              };
            })()
            """),
            timeout_s=8.0,
        )
        tor_ok = bool(
            popup_shown
            and "Tornado Warning" in popup_shown.get("title", "")
            and "INSIDE THE WARNING POLYGON" in popup_shown.get("body", "").upper()
            and popup_shown.get("ribbonCritical")
        )
        report.record("C3:Tornado", "Synthetic Tornado Warning fires modal, marks inside-polygon & critical ribbon", tor_ok, json.dumps(popup_shown))

        shot_tor = ARTIFACT_DIR / "tempest_mobile_tornado_warning.png"
        browser.screenshot(sid, shot_tor, full_page=False)
        report.add_screenshot(shot_tor, "Synthetic Tornado Warning alert popup on mobile")

        # Dismiss popup and check Alerts tab does NOT include expired/superseded alerts
        browser.evaluate(sid, "document.getElementById('btn-alert-popup-dismiss')?.click()")
        time.sleep(0.2)
        browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"alerts\"]')?.click()")
        time.sleep(0.3)
        alerts_text = browser.evaluate(sid, "document.getElementById('alerts-content')?.textContent || ''")
        purge_ok = (
            "Tornado Warning" in alerts_text
            and "EXPIRED Severe Thunderstorm Warning" not in alerts_text
            and "SUPERSEDED Severe Thunderstorm Warning" not in alerts_text
        )
        report.record("C3:Tornado", "Alerts DOM keeps active Tornado Warning and purges expired/superseded warnings", purge_ok)

        # Refresh TWICE while same Tornado Warning is active -> MUST NOT re-trigger duplicate popup!
        retriggered = False
        for _ in range(2):
            browser.evaluate(sid, "document.getElementById('btn-refresh')?.click()")
            time.sleep(1.2)
            is_open = browser.evaluate(sid, "!document.getElementById('alert-popup-modal')?.classList.contains('hidden')")
            if is_open:
                retriggered = True
        report.record("C3:Tornado", "Tornado Warning fires EXACTLY ONCE across repeated refreshes (no duplicate popup)", not retriggered)

        # Regression #35: Inject SECOND distinct active CRITICAL warning alongside already-notified #1 -> must NOT be shadow-blocked!
        router.set_scenario("tornado_second_critical")
        browser.evaluate(sid, "document.getElementById('btn-refresh')?.click()")
        second_popup = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const m = document.getElementById('alert-popup-modal');
              if (!m || m.classList.contains('hidden')) return null;
              return {
                title: document.getElementById('alert-popup-title')?.textContent || '',
                badge: document.getElementById('alert-popup-badge')?.textContent || '',
                body: document.getElementById('alert-popup-body')?.textContent || ''
              };
            })()
            """),
            timeout_s=8.0,
        )
        second_ok = bool(second_popup and "SECOND Tornado Warning" in second_popup.get("body", ""))
        report.record("C3:Tornado", "Second distinct CRITICAL warning fires cleanly (not shadow-blocked by #1)", second_ok, json.dumps(second_popup))
        browser.evaluate(sid, "document.getElementById('btn-alert-popup-dismiss')?.click()")
        time.sleep(0.2)

        # Now expire the Tornado Warning and refresh -> MUST clear immediately from DOM & badge!
        router.set_scenario("tornado_expired")
        browser.evaluate(sid, "document.getElementById('btn-refresh')?.click()")
        cleared_dom = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const txt = document.getElementById('alerts-content')?.textContent || '';
              const badge = document.getElementById('alerts-badge');
              const ribbon = document.getElementById('telemetry-ribbon');
              return !txt.includes('Tornado Warning') &&
                (badge?.classList.contains('hidden') || badge?.textContent === '0') &&
                !ribbon?.classList.contains('tone-critical');
            })()
            """),
            timeout_s=8.0,
        )
        report.record("C3:Tornado", "Expired Tornado Warning clears immediately from DOM, badge & critical ribbon", bool(cleared_dom))
    finally:
        browser.close()

    # --- C4: Geolocation Degradation Matrix (DENIED / UNAVAILABLE / TIMEOUT / MISSING) ---
    router = MockWeatherRouter(scenario="clear")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)

        geo_modes = [
            ("PERMISSION_DENIED", "({ getCurrentPosition: (_ok, err) => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'User denied' }), 10) })"),
            ("POSITION_UNAVAILABLE", "({ getCurrentPosition: (_ok, err) => setTimeout(() => err({ code: 2, POSITION_UNAVAILABLE: 2, message: 'Position unavailable' }), 10) })"),
            ("TIMEOUT", "({ getCurrentPosition: (_ok, err) => setTimeout(() => err({ code: 3, TIMEOUT: 3, message: 'Timed out' }), 10) })"),
            ("MISSING_GEOLOCATION", "undefined"),
        ]
        for mode_name, mock_expr in geo_modes:
            exc_before = len(browser.exceptions)
            browser.evaluate(sid, f"""
            Object.defineProperty(navigator, 'geolocation', {{
              configurable: true,
              value: {mock_expr}
            }});
            document.getElementById('btn-gps')?.click();
            """)
            time.sleep(0.35)
            state_after = browser.evaluate(sid, """
            ({
              loc: document.getElementById('header-location-name')?.textContent || '',
              toast: document.getElementById('toast')?.textContent || '',
              spinning: document.getElementById('btn-refresh')?.classList.contains('spinning') || false
            })
            """)
            ok = (
                len(browser.exceptions) == exc_before
                and "Booneville" in state_after["loc"]
                and not state_after["spinning"]
            )
            report.record("C4:Geolocation", f"Graceful home fallback on {mode_name}", ok, json.dumps(state_after))
    finally:
        browser.close()

    # --- C5: Offline / Mid-Fetch Drop + C6: Live DOM Radar Loop & visibilitychange ---
    router = MockWeatherRouter(scenario="clear")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True)
        # Instrument setInterval / clearInterval BEFORE app boots
        browser.add_init_script(sid, """
        (function () {
          const origSet = window.setInterval.bind(window);
          const origClear = window.clearInterval.bind(window);
          window.__ACTIVE_INTERVALS__ = new Map();
          window.setInterval = function (fn, ms, ...rest) {
            const id = origSet(fn, ms, ...rest);
            window.__ACTIVE_INTERVALS__.set(id, { ms, stack: (new Error()).stack || '' });
            return id;
          };
          window.clearInterval = function (id) {
            window.__ACTIVE_INTERVALS__.delete(id);
            return origClear(id);
          };
        })();
        """)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)

        # Open Radar tab, start playback, rapid-click speed & play, simulate visibilitychange hidden -> visible
        browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"radar\"]')?.click()")
        time.sleep(0.8)
        browser.evaluate(sid, """
        (() => {
          const play = document.getElementById('btn-radar-play');
          const spd = document.getElementById('btn-radar-speed');
          play?.click(); // start
          spd?.click();  // 2x
          spd?.click();  // 1x
        })()
        """)
        time.sleep(0.3)
        playing_intervals = browser.evaluate(sid, "[...window.__ACTIVE_INTERVALS__.values()].filter(v => v.ms <= 1000).length")
        report.record("C6:RadarLoop", "Playing radar maintains <= 1 animation interval (no duplicate timers)", playing_intervals == 1, f"intervals={playing_intervals}")

        # Simulate backgrounding (visibilitychange hidden = true)
        browser.evaluate(sid, """
        (() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        })()
        """)
        time.sleep(0.25)
        hidden_intervals = browser.evaluate(sid, "[...window.__ACTIVE_INTERVALS__.values()].filter(v => v.ms <= 1000).length")
        report.record("C6:RadarLoop", "Background visibilitychange pauses radar animation (0 animation intervals)", hidden_intervals == 0, f"intervals={hidden_intervals}")

        # Simulate foregrounding (visibilitychange hidden = false)
        browser.evaluate(sid, """
        (() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
        })()
        """)
        time.sleep(0.25)
        resumed_intervals = browser.evaluate(sid, "[...window.__ACTIVE_INTERVALS__.values()].filter(v => v.ms <= 1000).length")
        report.record("C6:RadarLoop", "Foreground visibilitychange resumes cleanly with exactly 1 interval (no zombie timers)", resumed_intervals == 1, f"intervals={resumed_intervals}")

        # Simulate iOS Safari BFCache pagehide -> pageshow (persisted=true) cycle
        total_intervals_before_bf = browser.evaluate(sid, "window.__ACTIVE_INTERVALS__.size")
        browser.evaluate(sid, """
        (() => {
          const ev = typeof PageTransitionEvent === 'function'
            ? new PageTransitionEvent('pagehide', { persisted: true })
            : Object.assign(new Event('pagehide'), { persisted: true });
          window.dispatchEvent(ev);
        })()
        """)
        time.sleep(0.2)
        bf_hidden_anim = browser.evaluate(sid, "[...window.__ACTIVE_INTERVALS__.values()].filter(v => v.ms <= 1000).length")
        browser.evaluate(sid, """
        (() => {
          const ev = typeof PageTransitionEvent === 'function'
            ? new PageTransitionEvent('pageshow', { persisted: true })
            : Object.assign(new Event('pageshow'), { persisted: true });
          window.dispatchEvent(ev);
        })()
        """)
        time.sleep(0.35)
        bf_resumed_anim = browser.evaluate(sid, "[...window.__ACTIVE_INTERVALS__.values()].filter(v => v.ms <= 1000).length")
        total_intervals_after_bf = browser.evaluate(sid, "window.__ACTIVE_INTERVALS__.size")
        bf_ok = (bf_hidden_anim == 0) and (bf_resumed_anim == 1) and (total_intervals_after_bf <= total_intervals_before_bf)
        report.record(
            "C6:RadarLoop",
            "iOS Safari BFCache pagehide/pageshow(persisted=true) pauses & resumes with zero zombie intervals",
            bf_ok,
            f"hidden_anim={bf_hidden_anim}, resumed_anim={bf_resumed_anim}, total_before={total_intervals_before_bf}, total_after={total_intervals_after_bf}",
        )

        # C5: Drop network completely mid-use and click refresh -> check zero crashes AND offline lastUpdated honesty
        sub_before = browser.evaluate(sid, "document.getElementById('header-status-sub')?.textContent || ''")
        router.set_scenario("offline_503")
        exc_before = len(browser.exceptions)
        browser.evaluate(sid, "document.getElementById('btn-refresh')?.click()")
        wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const sub = (document.getElementById('header-status-sub')?.textContent || '').toUpperCase();
              const spinning = document.getElementById('btn-refresh')?.classList.contains('spinning') || false;
              return !spinning && sub.includes('OFFLINE');
            })()
            """),
            timeout_s=10.0,
        )
        sub_after = browser.evaluate(sid, "document.getElementById('header-status-sub')?.textContent || ''")
        offline_ok = len(browser.exceptions) == exc_before and len(browser.leakage_violations) == 0
        report.record(
            "C5:Offline",
            "Connectivity drop mid-fetch causes zero uncaught exceptions or unhandled rejections",
            offline_ok,
            "" if offline_ok else json.dumps(browser.exceptions[exc_before:]),
        )
        prior_updated_part = ""
        if "Updated " in sub_before:
            prior_updated_part = sub_before.split("Updated ", 1)[1].split("•", 1)[0].strip()
        offline_honest = (
            "OFFLINE" in sub_after.upper()
            and (not prior_updated_part or prior_updated_part in sub_after or "OFFLINE OR PARTIAL" in sub_after.upper())
        )
        report.record(
            "C5:Offline",
            "Offline refresh flags OFFLINE cleanly and preserves prior Updated timestamp honestly",
            offline_honest,
            f"before={sub_before!r} | after={sub_after!r}",
        )
    finally:
        browser.close()

    # --- C5: Slow 3G Latency E2E Stress Test (500ms mocked network latency on mobile) ---
    router = MockWeatherRouter(scenario="slow_3g")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True, device_scale=2.0)
        t0 = time.time()
        browser.navigate(sid, f"{base_url}/")
        synced_slow = wait_for_app_synced(browser, sid, timeout_s=18.0)
        elapsed_s = round(time.time() - t0, 2)
        slow_ok = (
            synced_slow
            and elapsed_s >= 0.45
            and len(browser.console_errors) == 0
            and len(browser.exceptions) == 0
            and len(browser.leakage_violations) == 0
        )
        report.record(
            "C5:Slow3G",
            "App syncs cleanly under 500ms Slow-3G latency on mobile (0 errors, 0 leaks)",
            slow_ok,
            f"synced={synced_slow}, elapsed={elapsed_s}s, errs={len(browser.console_errors)}, exc={len(browser.exceptions)}, leaks={len(browser.leakage_violations)}",
        )
    finally:
        browser.close()

    # --- C7: Regressions for @ios-pwa-auditor #41-7 (Keyboard trigger, Settings slider DOM stability, switchActiveLocation alert isolation & voice timer cancel) ---
    router = MockWeatherRouter(scenario="tornado_active")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True, device_scale=2.0)
        browser.add_init_script(sid, """
        (function () {
          window.__SPEECH_COUNT__ = 0;
          if (window.speechSynthesis) {
            window.speechSynthesis.speak = () => { window.__SPEECH_COUNT__ += 1; };
            window.speechSynthesis.cancel = () => {};
          }
        })();
        """)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)

        # Wait for Tornado popup & immediately dismiss (< 1.2s) so voiceBriefingTimerId must cancel cleanly!
        popup_open = wait_until(
            lambda: browser.evaluate(sid, "!document.getElementById('alert-popup-modal')?.classList.contains('hidden')"),
            timeout_s=8.0,
        )
        browser.evaluate(sid, "document.getElementById('btn-alert-popup-dismiss')?.click()")
        time.sleep(1.5)
        speech_after_dismiss = browser.evaluate(sid, "window.__SPEECH_COUNT__")
        report.record(
            "C7:iOSUX",
            "Regression #41-7: Dismissing Tornado popup cancels pending 1.2s emergency speech briefing timer",
            bool(popup_open) and speech_after_dismiss == 0,
            f"popup_open={popup_open}, speech_count={speech_after_dismiss}",
        )

        # Keyboard Enter on #location-picker-trigger opens location modal, then search/switch to Tupelo under clear weather -> clears old Tornado alerts!
        router.set_scenario("clear")
        browser.evaluate(sid, """
        (() => {
          const trig = document.getElementById('location-picker-trigger');
          trig?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()
        """)
        modal_opened_kbd = wait_until(
            lambda: browser.evaluate(sid, "!document.getElementById('location-modal')?.classList.contains('hidden')"),
            timeout_s=3.0,
        )
        report.record("C7:iOSUX", "Regression #41-7: Keyboard Enter on #location-picker-trigger opens location modal", bool(modal_opened_kbd))

        browser.evaluate(sid, """
        (() => {
          const inp = document.getElementById('location-search-input');
          if (inp) {
            inp.value = 'Tupelo';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
          document.getElementById('btn-location-search')?.click();
        })()
        """)
        search_item_ready = wait_until(
            lambda: browser.evaluate(sid, "Boolean(document.querySelector('#location-search-results .loc-item[data-pick-hit]'))"),
            timeout_s=5.0,
        )
        browser.evaluate(sid, "document.querySelector('#location-search-results .loc-item[data-pick-hit]')?.click()")
        switched_clean = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const loc = document.getElementById('header-location-name')?.textContent || '';
              const badge = document.getElementById('alerts-badge');
              const ribbon = document.getElementById('telemetry-ribbon');
              return loc.includes('Tupelo') &&
                (badge?.classList.contains('hidden') || badge?.textContent === '0') &&
                !ribbon?.classList.contains('tone-critical');
            })()
            """),
            timeout_s=8.0,
        )
        report.record(
            "C7:iOSUX",
            "Regression #41-7: switchActiveLocation clears previous location Tornado alerts with zero cross-location bleed",
            bool(search_item_ready and switched_clean),
            f"search_ready={search_item_ready}, switched_clean={switched_clean}",
        )

        # Settings range slider DOM identity preserved mid-drag on iOS (#set-tot-lead & #set-freeze-slider)
        browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"settings\"]')?.click()")
        time.sleep(0.35)
        slider_ok = browser.evaluate(sid, """
        (() => {
          const tot = document.getElementById('set-tot-lead');
          const frz = document.getElementById('set-freeze-slider');
          if (!tot || !frz) return { found: false };
          tot.value = '25';
          tot.dispatchEvent(new Event('input', { bubbles: true }));
          frz.value = '34';
          frz.dispatchEvent(new Event('input', { bubbles: true }));
          return {
            found: true,
            totStillConnected: tot.isConnected && document.getElementById('set-tot-lead') === tot,
            frzStillConnected: frz.isConnected && document.getElementById('set-freeze-slider') === frz
          };
        })()
        """)
        report.record(
            "C7:iOSUX",
            "Regression #41-7: Settings sliders (#set-tot-lead, #set-freeze-slider) stay connected in DOM during iOS touch input",
            bool(slider_ok.get("found") and slider_ok.get("totStillConnected") and slider_ok.get("frzStillConnected")),
            json.dumps(slider_ok),
        )
    finally:
        browser.close()

    # --- C8: Interactive Radar Weather-System Click Inspection & Upgraded Broadcast Obsidian UI (#42/#43) ---
    router = MockWeatherRouter(scenario="weather_systems_rich")
    browser = CDPBrowser(base_url, mock_handler=router.handle)
    try:
        browser.start()
        sid = browser.new_page(width=390, height=844, mobile=True, device_scale=2.0)
        browser.navigate(sid, f"{base_url}/")
        wait_for_app_synced(browser, sid)

        # Dismiss Tornado Warning popup if open so we can inspect Dashboard UI & Radar tab cleanly
        wait_until(
            lambda: browser.evaluate(sid, "!document.getElementById('alert-popup-modal')?.classList.contains('hidden')"),
            timeout_s=5.0,
        )
        browser.evaluate(sid, "document.getElementById('btn-alert-popup-dismiss')?.click()")
        time.sleep(0.25)

        # Verify upgraded Broadcast Obsidian cockpit UI elements (hero glow, SVG gauges, sounding severity meters)
        ui_metrics = browser.evaluate(sid, """
        (() => {
          const hero = document.querySelector('.hero-card');
          const svgs = document.querySelectorAll('#dashboard-content svg').length;
          const meters = document.querySelectorAll('#dashboard-content .sev-meter-bar, #dashboard-content .severity-meter, #dashboard-content [class*="meter"]').length;
          const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
          return { hasHero: Boolean(hero), svgs, meters, overflow };
        })()
        """)
        report.record(
            "C8:RadarInspect",
            "Upgraded Broadcast Obsidian Dashboard renders SVG gauges & telemetry meters with 0 overflow",
            bool(ui_metrics.get("hasHero") and ui_metrics.get("svgs", 0) >= 2 and ui_metrics.get("meters", 0) >= 4 and not ui_metrics.get("overflow")),
            json.dumps(ui_metrics),
        )

        # Open Radar tab & wait for mock MapLibre map instance
        browser.evaluate(sid, "document.querySelector('.tab-btn[data-tab=\"radar\"]')?.click()")
        map_ready = wait_until(
            lambda: browser.evaluate(sid, "Boolean(window.__MAPLIBRE_MOCK_INSTANCES__ && window.__MAPLIBRE_MOCK_INSTANCES__.length > 0 && window.__MAPLIBRE_MOCK_INSTANCES__[0].styleLoadCount > 0)"),
            timeout_s=8.0,
        )
        time.sleep(0.4)
        report.record("C8:RadarInspect", "Radar map initializes cleanly under rich multi-system weather scenario", bool(map_ready))

        # 1. Click Storm Cell (34.60, -88.62) -> verify #radar-inspect-sheet opens with rich cell metadata + screenshot!
        browser.evaluate(sid, "window.__MAPLIBRE_MOCK_INSTANCES__[0]._emit('click', { lngLat: { lat: 34.60, lng: -88.62 }, point: { x: 150, y: 100 } })")
        cell_sheet = wait_until(
            lambda: browser.evaluate(sid, """
            (() => {
              const s = document.getElementById('radar-inspect-sheet');
              if (!s || s.classList.contains('hidden')) return null;
              return {
                title: document.getElementById('inspect-title')?.textContent || '',
                sub: document.getElementById('inspect-sub')?.textContent || '',
                body: document.getElementById('inspect-body')?.textContent || '',
                overflow: document.documentElement.scrollWidth > window.innerWidth + 1
              };
            })()
            """),
            timeout_s=5.0,
        )
        cell_ok = bool(
            cell_sheet
            and ("K4" in cell_sheet["title"] or "Cell" in cell_sheet["title"] or "Storm" in cell_sheet["title"])
            and "66" in cell_sheet["body"]
            and "TVS" in cell_sheet["body"].upper()
            and not cell_sheet["overflow"]
        )
        report.record(
            "C8:RadarInspect",
            "Clicking Storm Cell opens #radar-inspect-sheet with dBZ, TVS, Hail/VIL & TOT metadata (0 overflow)",
            cell_ok,
            json.dumps({k: (v[:160] if isinstance(v, str) else v) for k, v in (cell_sheet or {}).items()}),
        )
        shot_cell = ARTIFACT_DIR / "tempest_mobile_radar_inspect_cell.png"
        browser.screenshot(sid, shot_cell, full_page=False)
        report.add_screenshot(shot_cell, "Mobile Radar + Storm Cell Weather-System Inspector Sheet open")

        # 2. Click inside Tornado Warning polygon (away from cell: 34.68, -88.68) -> verify Warning details + overlapping multi-system switcher pills!
        browser.evaluate(sid, "window.__MAPLIBRE_MOCK_INSTANCES__[0]._emit('click', { lngLat: { lat: 34.68, lng: -88.68 }, point: { x: 120, y: 90 } })")
        time.sleep(0.25)
        warn_sheet = browser.evaluate(sid, """
        (() => {
          const s = document.getElementById('radar-inspect-sheet');
          if (!s || s.classList.contains('hidden')) return null;
          const pills = [...s.querySelectorAll('[data-switch-sys]')].map((el) => {
            const r = el.getBoundingClientRect();
            return { sys: el.getAttribute('data-switch-sys'), text: (el.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) };
          });
          return {
            title: document.getElementById('inspect-title')?.textContent || '',
            sub: document.getElementById('inspect-sub')?.textContent || '',
            body: document.getElementById('inspect-body')?.textContent || '',
            pills,
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1
          };
        })()
        """)
        warn_ok = bool(
            warn_sheet
            and "Tornado Warning" in warn_sheet["title"]
            and "OBSERVED" in warn_sheet["body"].upper()
            and "TAKE COVER" in warn_sheet["body"].upper()
            and len(warn_sheet.get("pills", [])) >= 3
            and all(p["h"] >= 44 for p in warn_sheet.get("pills", []) if p["h"] > 0)
            and not warn_sheet["overflow"]
        )
        report.record(
            "C8:RadarInspect",
            "Clicking NWS Tornado Warning opens rich Warning Inspector + >=44px multi-system switcher pills",
            warn_ok,
            json.dumps({
                "title": (warn_sheet or {}).get("title"),
                "pillCount": len((warn_sheet or {}).get("pills", [])),
                "pills": (warn_sheet or {}).get("pills", []),
            }),
        )
        shot_warn = ARTIFACT_DIR / "tempest_mobile_radar_inspect_warning.png"
        browser.screenshot(sid, shot_warn, full_page=False)
        report.add_screenshot(shot_warn, "Mobile Radar + NWS Tornado Warning Inspector & Multi-System Switcher")

        # 3. Click switcher pills inside #radar-inspect-sheet to verify Watch, MCD, Outlook & Point Intel switching!
        switched_types = {}
        for target_sys in ("watch", "mcd", "outlook", "point"):
            found_and_clicked = browser.evaluate(sid, f"""
            (() => {{
              const btn = document.querySelector('#radar-inspect-sheet [data-switch-sys^="{target_sys}"]');
              if (!btn) return null;
              btn.click();
              return {{
                title: document.getElementById('inspect-title')?.textContent || '',
                body: (document.getElementById('inspect-body')?.textContent || '').slice(0, 220)
              }};
            }})()
            """)
            if found_and_clicked:
                switched_types[target_sys] = found_and_clicked["title"]
        switcher_ok = (
            "watch" in switched_types
            and "mcd" in switched_types
            and "outlook" in switched_types
            and "point" in switched_types
        )
        report.record(
            "C8:RadarInspect",
            "Multi-system switcher pills cleanly flip between Watch, MCD, SPC Outlook & Point Intel",
            switcher_ok,
            json.dumps(switched_types),
        )

        # 4. Tap Open Map (outside ALL polygons: 32.50, -86.00) -> opens Point Intel fallback with coords, nearest cell, NEXRAD & CAPE/Shear!
        browser.evaluate(sid, "window.__MAPLIBRE_MOCK_INSTANCES__[0]._emit('click', { lngLat: { lat: 32.50, lng: -86.00 }, point: { x: 20, y: 20 } })")
        time.sleep(0.25)
        open_sheet = browser.evaluate(sid, """
        (() => {
          const s = document.getElementById('radar-inspect-sheet');
          if (!s || s.classList.contains('hidden')) return null;
          return {
            title: document.getElementById('inspect-title')?.textContent || '',
            sub: document.getElementById('inspect-sub')?.textContent || '',
            body: document.getElementById('inspect-body')?.textContent || ''
          };
        })()
        """)
        open_ok = bool(
            open_sheet
            and ("32.50" in open_sheet["sub"] or "32.50" in open_sheet["body"])
            and "K4" in open_sheet["body"]
            and "CAPE" in open_sheet["body"].upper()
        )
        report.record(
            "C8:RadarInspect",
            "Open-map radar tap opens Point Intel with coordinates, nearest storm cell & synoptic CAPE/Shear",
            open_ok,
            json.dumps({k: (v[:160] if isinstance(v, str) else v) for k, v in (open_sheet or {}).items()}),
        )

        # 5. Zero console errors, uncaught exceptions, or live network leaks during full radar inspection!
        report.record(
            "C8:RadarInspect",
            "Zero console errors, uncaught exceptions, or live network leaks during radar inspection E2E",
            len(browser.console_errors) == 0 and len(browser.exceptions) == 0 and len(browser.leakage_violations) == 0,
            "" if (not browser.console_errors and not browser.exceptions and not browser.leakage_violations) else json.dumps({
                "console_errors": browser.console_errors[:3],
                "exceptions": browser.exceptions[:3],
                "leaks": browser.leakage_violations[:3],
            }),
        )
    finally:
        browser.close()


def main() -> int:
    report = VerificationReport()
    server = LocalAppServer(APP_ROOT)
    base_url = server.start()
    print(f"=== Borden Tempest Adversarial QA Harness ({base_url}) ===", flush=True)
    try:
        run_suite_a_unit_tests(report, base_url)
        run_suite_b_service_worker(report, base_url, server)
        run_suite_c_e2e(report, base_url)
    except Exception as exc:
        report.record("RUNNER", "Unhandled harness exception", False, f"{exc}\n{traceback.format_exc()}")
    finally:
        server.stop()

    total = len(report.checks)
    failed = len(report.failed_checks)
    passed = total - failed

    summary = {
        "total": total,
        "passed": passed,
        "failed": failed,
        "screenshots": [{"path": p, "caption": c} for p, c in report.screenshots],
        "failures": report.failed_checks,
        "checks": report.checks,
    }
    (TESTS_DIR / "last_report.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("\n=== SUMMARY ===", flush=True)
    print(f"Total: {total} | Passed: {passed} | Failed: {failed}", flush=True)
    for p, c in report.screenshots:
        print(f"Screenshot: {p} | {c}", flush=True)
    if failed:
        print("\nFAILURES:", flush=True)
        for f in report.failed_checks:
            print(f"  - [{f['suite']}] {f['name']}: {f['detail']}", flush=True)
        return 1
    print("ALL VERIFICATION GATES PASSED", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

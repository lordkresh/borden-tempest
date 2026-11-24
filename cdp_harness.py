"""
Zero-dependency Python 3.14 Headless Chrome CDP + Local HTTP Test Harness
for Borden Tempest PWA adversarial verification.

Hard guarantees:
- Launches Chrome with --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"
  so ZERO packets can ever escape localhost to AWS S3, IEM, Open-Meteo, NWS, or any external host.
- Attaches CDP Fetch interception to ALL Page and Service Worker targets.
- Records any unexpected/unmocked external network attempt as a live-leakage violation.
- Captures all console errors, uncaught exceptions, unhandled promise rejections, and screenshots.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import mimetypes
import os
import queue
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
APP_ROOT = Path(r"c:\Users\jamie\Downloads\genetics\borden-tempest-ios")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class LocalAppServer:
    """Serves borden-tempest-ios/ over 127.0.0.1 with strict no-store headers and optional route overrides."""

    def __init__(self, root_dir: Path = APP_ROOT):
        self.root_dir = Path(root_dir)
        self.port = find_free_port()
        self.overrides: Dict[str, Tuple[int, str, bytes]] = {}
        self.request_log: List[str] = []
        self._lock = threading.Lock()
        self._httpd: Optional[http.server.ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    def set_override(self, path: str, status: int, content_type: str, body: bytes) -> None:
        with self._lock:
            self.overrides[path] = (status, content_type, body)

    def clear_overrides(self) -> None:
        with self._lock:
            self.overrides.clear()

    def start(self) -> str:
        parent = self

        class QuietHandler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt: str, *args: Any) -> None:
                pass

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self) -> None:
                parsed = urllib.parse.urlsplit(self.path)
                req_path = parsed.path
                with parent._lock:
                    parent.request_log.append(self.path)
                    override = parent.overrides.get(req_path)

                if override is not None:
                    status, ctype, data = override
                    self.send_response(status)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return

                rel = req_path.lstrip("/")
                if rel == "" or rel.endswith("/"):
                    rel += "index.html"
                full = (parent.root_dir / rel).resolve()
                try:
                    full.relative_to(parent.root_dir.resolve())
                except ValueError:
                    self.send_error(403)
                    return

                if not full.is_file():
                    self.send_response(404)
                    msg = b"Not Found"
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Content-Length", str(len(msg)))
                    self.end_headers()
                    self.wfile.write(msg)
                    return

                data = full.read_bytes()
                ctype = self._guess_mime(full)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                if full.name == "sw.js":
                    self.send_header("Service-Worker-Allowed", "/")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            @staticmethod
            def _guess_mime(path: Path) -> str:
                ext = path.suffix.lower()
                if ext == ".js" or ext == ".mjs":
                    return "application/javascript; charset=utf-8"
                if ext == ".css":
                    return "text/css; charset=utf-8"
                if ext == ".html":
                    return "text/html; charset=utf-8"
                if ext == ".webmanifest":
                    return "application/manifest+json; charset=utf-8"
                if ext == ".json":
                    return "application/json; charset=utf-8"
                if ext == ".svg":
                    return "image/svg+xml"
                if ext == ".png":
                    return "image/png"
                if ext == ".wav":
                    return "audio/wav"
                guessed, _ = mimetypes.guess_type(str(path))
                return guessed or "application/octet-stream"

        class QuietThreadingServer(http.server.ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address) -> None:
                if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
                    return
                super().handle_error(request, client_address)

        self._httpd = QuietThreadingServer(("127.0.0.1", self.port), QuietHandler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None


class RawWebSocket:
    """Minimal RFC 6455 client over stdlib TCP socket (handles large frames & masking)."""

    def __init__(self, ws_url: str, timeout: float = 15.0):
        parsed = urllib.parse.urlsplit(ws_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._send_lock = threading.Lock()
        self._closed = False

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket handshake closed prematurely")
            buf += chunk
        header_bytes, self._leftover = buf.split(b"\r\n\r\n", 1)
        status_line = header_bytes.split(b"\r\n", 1)[0].decode("latin1")
        if "101" not in status_line:
            raise ConnectionError(f"WebSocket handshake failed: {status_line}")

    def _recv_exact(self, n: int) -> bytes:
        chunks: List[bytes] = []
        remaining = n
        if self._leftover:
            take = min(remaining, len(self._leftover))
            chunks.append(self._leftover[:take])
            self._leftover = self._leftover[take:]
            remaining -= take
        while remaining > 0:
            chunk = self.sock.recv(min(65536, remaining))
            if not chunk:
                raise ConnectionError("WebSocket EOF")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray()
        header.append(0x81)  # FIN + text opcode
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            if not self._closed:
                self.sock.sendall(bytes(header) + masked)

    def send_pong(self, payload: bytes = b"") -> None:
        mask = os.urandom(4)
        header = bytearray([0x8A, 0x80 | len(payload)])
        header.extend(mask)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            if not self._closed:
                self.sock.sendall(bytes(header) + masked)

    def recv_text(self) -> str:
        fragments: List[bytes] = []
        while True:
            b1, b2 = self._recv_exact(2)
            fin = (b1 & 0x80) != 0
            opcode = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            if opcode == 0x8:  # close
                raise ConnectionError("WebSocket closed by remote")
            if opcode == 0x9:  # ping
                self.send_pong(payload)
                continue
            if opcode == 0xA:  # pong
                continue
            fragments.append(payload)
            if fin:
                return b"".join(fragments).decode("utf-8", errors="replace")

    def close(self) -> None:
        self._closed = True
        try:
            self.sock.close()
        except Exception:
            pass


class CDPBrowser:
    """
    Manages a headless Chrome process, a browser-level CDP WebSocket,
    multi-target Fetch interception (Page + Service Workers), console/exception tracking,
    and zero-live-network-leakage enforcement.
    """

    def __init__(
        self,
        local_origin: str,
        mock_handler: Optional[Callable[[str, str, Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
        chrome_path: str = CHROME_PATH,
    ):
        self.local_origin = local_origin.rstrip("/")
        self.mock_handler = mock_handler
        self.chrome_path = chrome_path
        self.debug_port = find_free_port()
        self.user_data_dir = tempfile.mkdtemp(prefix="tempest_qa_chrome_")
        self.proc: Optional[subprocess.Popen] = None
        self.ws: Optional[RawWebSocket] = None

        self._cmd_id = 0
        self._cmd_lock = threading.Lock()
        self._pending: Dict[int, Tuple[threading.Event, Dict[str, Any]]] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._dispatch_queue: queue.Queue = queue.Queue()
        self._worker_thread: Optional[threading.Thread] = None
        self._running = False

        self.console_messages: List[Dict[str, Any]] = []
        self.console_errors: List[Dict[str, Any]] = []
        self.exceptions: List[Dict[str, Any]] = []
        self.external_requests: List[Dict[str, Any]] = []
        self.leakage_violations: List[Dict[str, Any]] = []
        self.sw_sessions: List[str] = []
        self._attached_sessions: Dict[str, Dict[str, Any]] = {}
        self._event_listeners: Dict[str, List[Callable[[Dict[str, Any], Optional[str]], None]]] = {}

    def start(self) -> None:
        args = [
            self.chrome_path,
            "--headless=new",
            f"--remote-debugging-port={self.debug_port}",
            f"--user-data-dir={self.user_data_dir}",
            "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-component-update",
            "--disable-default-apps",
            "--metrics-recording-only",
            "--mute-audio",
            "--autoplay-policy=no-user-gesture-required",
            "about:blank",
        ]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        ws_url = None
        deadline = time.time() + 15.0
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.debug_port}/json/version", timeout=1.0) as r:
                    info = json.loads(r.read().decode("utf-8"))
                    ws_url = info.get("webSocketDebuggerUrl")
                    if ws_url:
                        break
            except Exception:
                time.sleep(0.15)
        if not ws_url:
            raise RuntimeError("Failed to connect to headless Chrome CDP endpoint")

        self.ws = RawWebSocket(ws_url, timeout=30.0)
        self._running = True
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        self._worker_thread = threading.Thread(target=self._dispatch_loop, daemon=True)
        self._worker_thread.start()

        # Enable auto-attach across all pages & Service Workers so NOTHING escapes Fetch interception
        self.send("Target.setDiscoverTargets", {"discover": True})
        self.send("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": True,
            "flatten": True,
        })

    def close(self) -> None:
        self._running = False
        try:
            self._dispatch_queue.put(None)
        except Exception:
            pass
        if self.ws:
            self.ws.close()
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        shutil.rmtree(self.user_data_dir, ignore_errors=True)

    def reset_logs(self) -> None:
        self.console_messages.clear()
        self.console_errors.clear()
        self.exceptions.clear()
        self.external_requests.clear()
        self.leakage_violations.clear()

    def send(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
        timeout: float = 20.0,
    ) -> Dict[str, Any]:
        with self._cmd_lock:
            self._cmd_id += 1
            cid = self._cmd_id
            ev = threading.Event()
            box: Dict[str, Any] = {}
            self._pending[cid] = (ev, box)

        msg: Dict[str, Any] = {"id": cid, "method": method}
        if params is not None:
            msg["params"] = params
        if session_id:
            msg["sessionId"] = session_id

        assert self.ws is not None
        self.ws.send_text(json.dumps(msg))
        if not ev.wait(timeout):
            with self._cmd_lock:
                self._pending.pop(cid, None)
            raise TimeoutError(f"CDP command {method} timed out after {timeout}s")

        if "error" in box:
            raise RuntimeError(f"CDP error for {method}: {box['error']}")
        return box.get("result", {})

    def send_async(self, method: str, params: Optional[Dict[str, Any]] = None, session_id: Optional[str] = None) -> None:
        with self._cmd_lock:
            self._cmd_id += 1
            cid = self._cmd_id
        msg: Dict[str, Any] = {"id": cid, "method": method}
        if params is not None:
            msg["params"] = params
        if session_id:
            msg["sessionId"] = session_id
        try:
            if self.ws:
                self.ws.send_text(json.dumps(msg))
        except Exception:
            pass

    def _read_loop(self) -> None:
        assert self.ws is not None
        while self._running:
            try:
                raw = self.ws.recv_text()
            except socket.timeout:
                continue
            except Exception:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if "id" in msg:
                cid = msg["id"]
                with self._cmd_lock:
                    item = self._pending.pop(cid, None)
                if item:
                    ev, box = item
                    box.update(msg)
                    ev.set()
            elif "method" in msg:
                self._dispatch_queue.put(msg)

    def _dispatch_loop(self) -> None:
        while self._running:
            msg = self._dispatch_queue.get()
            if msg is None:
                break
            method = msg.get("method", "")
            params = msg.get("params", {})
            sid = msg.get("sessionId")
            try:
                if method == "Target.attachedToTarget":
                    self._on_attached(params)
                elif method == "Fetch.requestPaused":
                    self._on_fetch_paused(params, sid)
                elif method == "Runtime.consoleAPICalled":
                    self._on_console(params, sid)
                elif method == "Runtime.exceptionThrown":
                    self._on_exception(params, sid)
                for cb in self._event_listeners.get(method, []):
                    try:
                        cb(params, sid)
                    except Exception:
                        pass
            except Exception:
                pass

    def _on_attached(self, params: Dict[str, Any]) -> None:
        child_sid = params.get("sessionId")
        info = params.get("targetInfo", {})
        ttype = info.get("type", "")
        if not child_sid:
            return
        self._attached_sessions[child_sid] = info
        if ttype == "service_worker":
            self.sw_sessions.append(child_sid)

        if ttype in ("page", "service_worker", "worker", "iframe"):
            # Intercept ALL http/https traffic in every target (Page & SW)
            self.send_async("Fetch.enable", {
                "patterns": [
                    {"urlPattern": "https://*"},
                    {"urlPattern": "http://*"},
                ]
            }, session_id=child_sid)
            self.send_async("Runtime.enable", {}, session_id=child_sid)
            if ttype == "page":
                self.send_async("Page.enable", {}, session_id=child_sid)
                self.send_async("Network.enable", {}, session_id=child_sid)
            # Also auto-attach nested workers (e.g. Service Workers spawned by a Page!)
            self.send_async("Target.setAutoAttach", {
                "autoAttach": True,
                "waitForDebuggerOnStart": True,
                "flatten": True,
            }, session_id=child_sid)

        if params.get("waitingForDebugger"):
            self.send_async("Runtime.runIfWaitingForDebugger", {}, session_id=child_sid)

    def _on_fetch_paused(self, params: Dict[str, Any], session_id: Optional[str]) -> None:
        req_id = params.get("requestId")
        req = params.get("request", {})
        url = req.get("url", "")
        method = req.get("method", "GET").upper()

        # Allow local test server requests directly
        if url.startswith(self.local_origin + "/") or url == self.local_origin:
            self.send_async("Fetch.continueRequest", {"requestId": req_id}, session_id=session_id)
            return

        # CORS preflight
        if method == "OPTIONS":
            self.send_async("Fetch.fulfillRequest", {
                "requestId": req_id,
                "responseCode": 204,
                "responseHeaders": [
                    {"name": "Access-Control-Allow-Origin", "value": "*"},
                    {"name": "Access-Control-Allow-Methods", "value": "GET, POST, HEAD, OPTIONS"},
                    {"name": "Access-Control-Allow-Headers", "value": "*"},
                ],
                "body": "",
            }, session_id=session_id)
            return

        target_type = self._attached_sessions.get(session_id or "", {}).get("type", "unknown")
        self.external_requests.append({"url": url, "method": method, "target": target_type})

        result = None
        if self.mock_handler:
            try:
                result = self.mock_handler(url, method, req)
            except Exception as exc:
                result = {"fail": "Failed", "leak": True, "reason": f"mock_handler error: {exc}"}

        if result is None or result.get("leak"):
            self.leakage_violations.append({
                "url": url,
                "method": method,
                "target": target_type,
                "reason": (result or {}).get("reason", "Unmocked external URL blocked by zero-leakage gate"),
            })
            self.send_async("Fetch.failRequest", {
                "requestId": req_id,
                "errorReason": "BlockedByClient",
            }, session_id=session_id)
            return

        if result.get("fail"):
            self.send_async("Fetch.failRequest", {
                "requestId": req_id,
                "errorReason": result["fail"],
            }, session_id=session_id)
            return

        status = int(result.get("status", 200))
        headers = dict(result.get("headers", {}))
        if not result.get("omit_cors"):
            headers.setdefault("Access-Control-Allow-Origin", "*")
            headers.setdefault("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS")
            headers.setdefault("Access-Control-Allow-Headers", "*")
        headers.setdefault("Cache-Control", "no-store")
        headers.setdefault("Content-Type", result.get("content_type", "application/json; charset=utf-8"))

        body_raw = result.get("body", b"")
        if isinstance(body_raw, str):
            body_bytes = body_raw.encode("utf-8")
        elif isinstance(body_raw, (dict, list)):
            body_bytes = json.dumps(body_raw).encode("utf-8")
        else:
            body_bytes = bytes(body_raw)

        cdp_headers = [{"name": k, "value": str(v)} for k, v in headers.items()]
        fulfill_params = {
            "requestId": req_id,
            "responseCode": status,
            "responseHeaders": cdp_headers,
            "body": base64.b64encode(body_bytes).decode("ascii"),
        }
        delay_ms = float(result.get("delay_ms", 0) or 0)
        if delay_ms > 0:
            timer = threading.Timer(
                delay_ms / 1000.0,
                lambda: self.send_async("Fetch.fulfillRequest", fulfill_params, session_id=session_id),
            )
            timer.daemon = True
            timer.start()
        else:
            self.send_async("Fetch.fulfillRequest", fulfill_params, session_id=session_id)

    def _on_console(self, params: Dict[str, Any], session_id: Optional[str]) -> None:
        ctype = params.get("type", "log")
        args = params.get("args", [])
        parts = []
        for a in args:
            if "value" in a:
                parts.append(str(a["value"]))
            elif "description" in a:
                parts.append(str(a["description"]))
            else:
                parts.append(str(a.get("type", "")))
        text = " ".join(parts)
        entry = {"type": ctype, "text": text, "target": self._attached_sessions.get(session_id or "", {}).get("type", "page")}
        self.console_messages.append(entry)
        if ctype == "error":
            self.console_errors.append(entry)

    def _on_exception(self, params: Dict[str, Any], session_id: Optional[str]) -> None:
        det = params.get("exceptionDetails", {})
        exc_obj = det.get("exception", {})
        entry = {
            "text": det.get("text", ""),
            "description": exc_obj.get("description", exc_obj.get("value", "")),
            "url": det.get("url", ""),
            "line": det.get("lineNumber"),
            "target": self._attached_sessions.get(session_id or "", {}).get("type", "page"),
        }
        self.exceptions.append(entry)

    def new_page(self, width: int = 1280, height: int = 800, mobile: bool = False, device_scale: float = 1.0) -> str:
        res = self.send("Target.createTarget", {"url": "about:blank"})
        target_id = res["targetId"]
        attach = self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        sid = attach["sessionId"]
        self._attached_sessions[sid] = {"type": "page", "targetId": target_id}
        self.send("Page.enable", {}, session_id=sid)
        self.send("Runtime.enable", {}, session_id=sid)
        self.send("Network.enable", {}, session_id=sid)
        self.send("Fetch.enable", {
            "patterns": [
                {"urlPattern": "https://*"},
                {"urlPattern": "http://*"},
            ]
        }, session_id=sid)
        self.send("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": True,
            "flatten": True,
        }, session_id=sid)
        self.set_viewport(sid, width, height, mobile=mobile, device_scale=device_scale)
        return sid

    def close_page(self, session_id: str) -> None:
        info = self._attached_sessions.get(session_id, {})
        tid = info.get("targetId")
        if tid:
            try:
                self.send("Target.closeTarget", {"targetId": tid})
            except Exception:
                pass

    def set_viewport(self, session_id: str, width: int, height: int, mobile: bool = False, device_scale: float = 1.0) -> None:
        self.send("Emulation.setDeviceMetricsOverride", {
            "width": width,
            "height": height,
            "deviceScaleFactor": device_scale,
            "mobile": mobile,
        }, session_id=session_id)

    def set_timezone(self, session_id: str, tz_id: str) -> None:
        self.send("Emulation.setTimezoneOverride", {"timezoneId": tz_id}, session_id=session_id)

    def add_init_script(self, session_id: str, js_source: str) -> None:
        self.send("Page.addScriptToEvaluateOnNewDocument", {"source": js_source}, session_id=session_id)

    def navigate(self, session_id: str, url: str, wait_load_s: float = 15.0) -> None:
        loaded = threading.Event()

        def on_load(_params: Dict[str, Any], sid: Optional[str]) -> None:
            if sid == session_id:
                loaded.set()

        self._event_listeners.setdefault("Page.loadEventFired", []).append(on_load)
        try:
            self.send("Page.navigate", {"url": url}, session_id=session_id)
            if not loaded.wait(wait_load_s):
                raise TimeoutError(f"Page.loadEventFired timed out navigating to {url}")
        finally:
            self._event_listeners["Page.loadEventFired"].remove(on_load)

    def evaluate(self, session_id: str, expression: str, await_promise: bool = True, timeout: float = 30.0) -> Any:
        res = self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        }, session_id=session_id, timeout=timeout)
        if "exceptionDetails" in res:
            det = res["exceptionDetails"]
            desc = det.get("exception", {}).get("description") or det.get("text")
            raise RuntimeError(f"JS evaluation error: {desc}")
        return res.get("result", {}).get("value")

    def screenshot(self, session_id: str, out_path: Path, full_page: bool = False) -> Path:
        params: Dict[str, Any] = {"format": "png"}
        if full_page:
            params["captureBeyondViewport"] = True
        res = self.send("Page.captureScreenshot", params, session_id=session_id, timeout=20.0)
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(base64.b64decode(res["data"]))
        return out_path

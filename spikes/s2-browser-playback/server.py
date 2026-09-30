"""S2 (throwaway): static server with HTTP Range support + POST /report.

Serves spikes/s2-browser-playback/{index.html,out/...} on http://localhost:8765
Reports posted by the test page are saved to out/reports/<browser>-<timestamp>.json
"""
import json
import mimetypes
import os
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "out" / "reports"
PORT = int(os.environ.get("PORT", "8765"))

mimetypes.add_type("video/x-matroska", ".mkv")
mimetypes.add_type("application/vnd.apple.mpegurl", ".m3u8")
mimetypes.add_type("video/iso.segment", ".m4s")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("text/vtt", ".vtt")
mimetypes.add_type("application/octet-stream", ".sup")
mimetypes.add_type("text/javascript", ".js")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/report":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = json.loads(body)
        REPORTS.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^a-z0-9]+", "-", data.get("browser", "unknown").lower()).strip("-")
        out = REPORTS / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.json"
        out.write_text(json.dumps(data, indent=2), encoding="utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"saved": out.name}).encode())

    def send_head(self):
        """Serve single byte ranges (enough for <video> seeking)."""
        rng = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if not rng or not path.is_file():
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        size = path.stat().st_size
        if not m:
            return super().send_head()
        start = int(m.group(1)) if m.group(1) else size - int(m.group(2))
        end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        try:
            while remaining > 0:
                chunk = source.read(min(1 << 20, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass  # the browser aborts range requests while seeking
        finally:
            self._remaining = None

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"S2 test page: http://localhost:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

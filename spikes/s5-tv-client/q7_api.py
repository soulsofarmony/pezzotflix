"""S5 (throwaway): what the Pezzotflix Decision Engine plans for this TV, and whether the locator works for a
native player (HTTP Range through the Caddy gateway).

For every playable item and every capability file given: StartPlayback with those capabilities, record mode,
protocol, mimeType, selected tracks and reasons; probe the locator with Range requests; stop and free the slot.
Usage: python -I q7_api.py http://192.168.1.5:18380 caps1.json [caps2.json ...]
Writes out/results/q7-plans.json. Never prints secrets (none are needed: the MVP has no auth).
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
caps_files = sys.argv[2:]
out = pathlib.Path(__file__).resolve().parent / "out" / "results" / "q7-plans.json"


def call(method, path, token=None, body=None, headers=None, raw=False):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            return r.status, dict(r.headers), data if raw else (json.loads(data) if data else None)
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            return e.code, dict(e.headers), json.loads(data)
        except Exception:
            return e.code, dict(e.headers), data[:300]


# Wait for the ingest to settle.
for _ in range(60):
    st, _, ing = call("GET", "/video/api/v1/admin/ingest")
    if st == 200 and not ing.get("running", False) and ing.get("queued", 0) == 0:
        break
    time.sleep(2)

st, _, prof = call("GET", "/video/api/v1/profiles")
if not prof["profiles"]:
    call("POST", "/video/api/v1/profiles", body={"name": "S5 TV"})
    st, _, prof = call("GET", "/video/api/v1/profiles")
pid = prof["profiles"][0]["id"]
token = call("POST", f"/video/api/v1/profiles/{pid}/select")[2]["profileToken"]

items = []
for kind in ("movie", "episode", "extra"):
    st, _, page = call("GET", f"/video/api/v1/items?kind={kind}&limit=100", token)
    if st == 200:
        items += page["items"]

results = []
for cf in caps_files:
    caps = json.loads(pathlib.Path(cf).read_text(encoding="utf-8"))
    caps.pop("ev", None)
    caps.pop("t", None)
    for it in items:
        # Free the single MVP slot first.
        for s in (call("GET", "/video/api/v1/playback/sessions", token)[2] or {}).get("sessions", []):
            call("DELETE", f"/video/api/v1/playback/sessions/{s['sessionId']}", token)
        t0 = time.time()
        st, _, s = call("POST", "/video/api/v1/playback/sessions", token, {"itemId": it["id"], "capabilities": caps})
        rec = {"caps": pathlib.Path(cf).name, "item": it["title"], "kind": it["kind"], "status": st, "startMs": round((time.time() - t0) * 1000)}
        if st == 201:
            stream = s["stream"]
            rec.update({
                "mode": s["mode"], "protocol": stream["protocol"], "mimeType": stream.get("mimeType"), "reasons": s["reasons"],
                "bitrate": stream.get("bitrate"),
                "audio": [f"{a.get('codec')} {a.get('channels')}ch {a.get('language')}" for a in s["tracks"]["audio"] if a["selected"]],
                "subs": [f"{x.get('codec')} {x.get('language')} {x.get('delivery')}" for x in s["tracks"]["subtitles"] if x["selected"]],
                "url": stream["url"].split("/s/")[0] + "/s/<token>/" + stream["url"].split("/", 5)[-1].split("/", 1)[-1],
            })
            if stream["protocol"] == "progressive":
                a = call("GET", stream["url"], headers={"Range": "bytes=0-1023"}, raw=True)
                b = call("GET", stream["url"], headers={"Range": "bytes=-1024"}, raw=True)
                rec["range"] = {
                    "first": [a[0], a[1].get("Content-Range"), a[1].get("Content-Type"), a[1].get("Accept-Ranges"), len(a[2])],
                    "last": [b[0], b[1].get("Content-Range"), len(b[2])],
                }
            else:
                a = call("GET", stream["url"], raw=True)
                rec["playlist"] = [a[0], a[1].get("Content-Type"), a[2][:200].decode(errors="replace")]
            call("POST", f"/video/api/v1/playback/sessions/{s['sessionId']}/stop", token, {"positionMs": 0})
            call("DELETE", f"/video/api/v1/playback/sessions/{s['sessionId']}", token)
        else:
            rec["error"] = s
        results.append(rec)
        print(f"{rec['caps'][:26]:26} {it['title'][:34]:34} {st} {rec.get('mode', '-'):13} {rec.get('protocol', '-'):12} "
              f"{','.join(rec.get('audio', []))[:40]:40} {rec.get('mimeType') or ''}")

out.write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out}")

"""S5 (throwaway): opens one playback session on the pzf-s5 stack and prints what the TV player needs, as JSON.

Usage: python -I ds_session.py http://192.168.1.5:18380 "<title substring>" caps.json
Prints {"mode", "protocol", "url", "session", "token", "subUrl", "subMime", "mediaTimestampOffsetMs", "reasons"}.
The profile token is a short-lived test token of the throwaway stack; it is not written to any tracked file.
"""
import json
import pathlib
import sys
import urllib.request

base, want, caps_file = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]


def call(method, path, token=None, body=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        return json.loads(data) if data else None


pid = call("GET", "/video/api/v1/profiles")["profiles"][0]["id"]
token = call("POST", f"/video/api/v1/profiles/{pid}/select", body={})["profileToken"]
items = []
for kind in ("movie", "episode", "extra"):
    items += call("GET", f"/video/api/v1/items?kind={kind}&limit=100", token)["items"]
item = next(i for i in items if want.lower() in i["title"].lower())
for s in (call("GET", "/video/api/v1/playback/sessions", token) or {}).get("sessions", []):
    call("DELETE", f"/video/api/v1/playback/sessions/{s['sessionId']}", token)
caps = json.loads(pathlib.Path(caps_file).read_text(encoding="utf-8"))
caps.pop("ev", None)
caps.pop("t", None)
s = call("POST", "/video/api/v1/playback/sessions", token, {"itemId": item["id"], "capabilities": caps})
st = s["stream"]
sub = next((t for t in s["tracks"]["subtitles"] if t["selected"] and t.get("url")), None)
print(json.dumps({"mode": s["mode"], "protocol": st["protocol"], "url": base + st["url"], "session": s["sessionId"], "token": token,
                  "subUrl": base + sub["url"] if sub else "", "subMime": ("application/pgs" if sub and sub.get("delivery") == "client_render" else "text/vtt"),
                  "mediaTimestampOffsetMs": st.get("mediaTimestampOffsetMs"), "reasons": s["reasons"]}, ensure_ascii=False))

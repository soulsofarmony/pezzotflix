"""S2 (throwaway): list PGS display sets (expected cue times) from .sup files.

Usage: python -I sup_cues.py out/media/a.sup [b.sup ...]  -> prints JSON to stdout
A display set starts with a PCS (0x16); objects>0 means "show", 0 means "clear".
"""
import json
import struct
import sys


def cues(path):
    data = open(path, "rb").read()
    i, out, width, height = 0, [], None, None
    while i + 13 <= len(data):
        magic, pts, _dts, seg, size = struct.unpack(">2sIIBH", data[i:i + 13])
        if magic != b"PG":
            raise ValueError(f"bad magic at {i}")
        body = data[i + 13:i + 13 + size]
        if seg == 0x16:  # presentation composition segment
            w, h = struct.unpack(">HH", body[0:4])
            width, height = w, h
            comp_state = body[7]
            n_obj = body[10]
            out.append({"t": round(pts / 90000, 3), "objects": n_obj, "state": comp_state})
        i += 13 + size
    return {"file": path, "width": width, "height": height, "displaySets": out}


if __name__ == "__main__":
    print(json.dumps([cues(p) for p in sys.argv[1:]], indent=1))

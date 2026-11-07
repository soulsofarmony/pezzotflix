"""Throwaway: list integer properties that hold epoch ms or byte sizes and write a copy of the bundle with format int64."""
import json
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
spec = json.load(open(src, encoding="utf-8"))
NAME = re.compile(r"(At|Ts|Since|Bytes)$|^at$")
hits = []


def walk(node, path):
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict):
            for name, schema in props.items():
                t = schema.get("type") if isinstance(schema, dict) else None
                is_int = t == "integer" or (isinstance(t, list) and "integer" in t)
                if is_int and NAME.search(name) and "format" not in schema:
                    hits.append(f"{path}.{name}")
                    schema["format"] = "int64"
        for k, v in node.items():
            walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]")


walk(spec, "$")
json.dump(spec, open(dst, "w", encoding="utf-8"), indent=1)
print(len(hits), "properties patched")
for h in hits:
    print(" ", h.replace("$.components.schemas.", ""))

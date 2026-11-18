import hashlib
import json
from urllib.parse import urlsplit
import requests

admin = "http://proxy:8474"
base = "http://proxy:8669"
requests.post(admin + "/proxies/registry", json={"enabled": False}, timeout=3).raise_for_status()
try:
    requests.get(base + "/v2/", timeout=1).raise_for_status()
    raise AssertionError("registry proxy did not cut the connection")
except requests.RequestException:
    pass
requests.post(admin + "/proxies/registry", json={"enabled": True}, timeout=3).raise_for_status()
requests.get(base + "/v2/", timeout=3).raise_for_status()
blob = b"hobo-fuzz-registry-fixture"
digest = "sha256:" + hashlib.sha256(blob).hexdigest()
started = requests.post(base + "/v2/fixture/blobs/uploads/", timeout=3)
started.raise_for_status()
location = urlsplit(started.headers["Location"])
url = base + location.path
if location.query:
    url += "?" + location.query
uploaded = requests.put(url, params={"digest": digest}, data=blob, timeout=3)
uploaded.raise_for_status()
loaded = requests.get(base + "/v2/fixture/blobs/" + digest, timeout=3)
loaded.raise_for_status()
if loaded.content != blob:
    raise AssertionError("registry returned a different blob")
print(json.dumps({"cut_recovered": True, "blob_roundtrip": True}))

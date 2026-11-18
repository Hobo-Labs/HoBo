import json
import time
import requests

admin = "http://proxy:8474"
control = "http://proxy:8666"
headers = {"x-hobo-tenant": "tenant-a"}


def configure(name, port, upstream):
    response = requests.post(admin + "/proxies", json={"name": name, "listen": f"0.0.0.0:{port}", "upstream": upstream, "enabled": True}, timeout=3)
    response.raise_for_status()


def add_toxic(name, kind, attributes, proxy="control"):
    response = requests.post(admin + f"/proxies/{proxy}/toxics", json={"name": name, "type": kind, "stream": "downstream", "toxicity": 1, "attributes": attributes}, timeout=3)
    response.raise_for_status()


def remove_toxic(name, proxy="control"):
    requests.delete(admin + f"/proxies/{proxy}/toxics/{name}", timeout=3).raise_for_status()


configure("control", 8666, "target:8080")
configure("database", 8667, "database:5432")
configure("queue", 8668, "queue:6379")
configure("registry", 8669, "registry:5000")
response = requests.post(control + "/v1/bindles", headers=headers, json={"bindleId": "fault-app", "manifestHash": "hash"}, timeout=3)
response.raise_for_status()
request = {"idempotencyKey": "once"}
first = requests.post(control + "/v1/bindles/fault-app/apply", headers=headers, json=request, timeout=3)
first.raise_for_status()
first_id = first.json()["id"]
for index in range(12):
    requests.post(control + "/v1/bindles/fault-app/apply", headers=headers, json={"idempotencyKey": f"bandwidth-{index}"}, timeout=3).raise_for_status()
add_toxic("slow", "latency", {"latency": 180, "jitter": 0})
started = time.monotonic()
response = requests.get(control + "/v1/tenants/tenant-a/resources", headers=headers, timeout=3)
response.raise_for_status()
latency = time.monotonic() - started
if latency < 0.12:
    raise AssertionError("latency toxic did not delay the response")
remove_toxic("slow")
add_toxic("bandwidth", "bandwidth", {"rate": 2})
started = time.monotonic()
response = requests.get(control + "/v1/tenants/tenant-a/resources", headers=headers, timeout=5)
response.raise_for_status()
bandwidth = time.monotonic() - started
if bandwidth < 0.2:
    raise AssertionError("bandwidth toxic did not throttle the response")
remove_toxic("bandwidth")
add_toxic("timeout", "timeout", {"timeout": 0})
timed_out = False
try:
    requests.get(control + "/v1/tenants/tenant-a/resources", headers=headers, timeout=0.25).raise_for_status()
except requests.RequestException:
    timed_out = True
if not timed_out:
    raise AssertionError("timeout toxic did not interrupt the request")
remove_toxic("timeout")
add_toxic("reset", "reset_peer", {"timeout": 0})
reset = False
try:
    requests.post(control + "/v1/bindles/fault-app/apply", headers=headers, json=request, timeout=3).raise_for_status()
except requests.RequestException:
    reset = True
if not reset:
    raise AssertionError("reset toxic did not interrupt the request")
remove_toxic("reset")
replayed = requests.post(control + "/v1/bindles/fault-app/apply", headers=headers, json=request, timeout=3)
replayed.raise_for_status()
if replayed.json()["id"] != first_id:
    raise AssertionError("retry created a duplicate resource")
requests.post(admin + "/proxies/control", json={"enabled": False}, timeout=3).raise_for_status()
cut = False
try:
    requests.get(control + "/v1/tenants/tenant-a/resources", headers=headers, timeout=1).raise_for_status()
except requests.RequestException:
    cut = True
if not cut:
    raise AssertionError("disabled proxy did not cut the connection")
requests.post(admin + "/proxies/control", json={"enabled": True}, timeout=3).raise_for_status()
requests.get(control + "/v1/tenants/tenant-a/resources", headers=headers, timeout=3).raise_for_status()
print(json.dumps({"latency_ms": round(latency * 1000), "bandwidth_ms": round(bandwidth * 1000), "timeout": timed_out, "reset": reset, "cut": cut, "idempotent": True}))

"""Replay a recorded Gemini request in variants and count mid-stream errors.

python3 -I replay.py <req.json> <repeats>
"""
import concurrent.futures, copy, json, os, sys, urllib.request

req = json.load(open(sys.argv[1])); n = int(sys.argv[2])
url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse"
key = os.environ["GEMINI_API_KEY"]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": os.environ["HTTPS_PROXY"]}))

def descriptor_index(r):
    return max(i for i, c in enumerate(r["contents"]) if c["role"] == "user" and c["parts"][0].get("text", "").startswith("<spine_node"))

def moved(r):
    r = copy.deepcopy(r); i = descriptor_index(r); d = r["contents"].pop(i)
    r["contents"].insert(i + 2, d)  # after the model turn and its function responses
    return r

def unsigned(r):
    r = copy.deepcopy(r)
    for c in r["contents"]:
        for p in c["parts"]: p.pop("thoughtSignature", None)
    return r

def call(body):
    q = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        text = opener.open(q, timeout=180).read().decode()
    except Exception as e:
        return f"exc {getattr(e, 'code', '')} {str(e)[:80]}"
    if '"error"' in text: return "midstream-error " + text[text.find('"message"'):][:60]
    calls = [l for l in text.splitlines() if '"functionCall"' in l]
    return "ok " + (json.loads(calls[0][5:])["candidates"][0]["content"]["parts"][-1]["functionCall"]["name"] if calls else "text")

variants = {"A original": req, "B moved": moved(req)}
with concurrent.futures.ThreadPoolExecutor(1) as pool:
    jobs = {name: [pool.submit(call, body) for _ in range(n)] for name, body in variants.items()}
    for name, fs in jobs.items():
        results = [f.result() for f in fs]
        print(name, sum(r.startswith("ok") for r in results), "/", n, results)

import urllib.request, json, time, uuid, http.client

results = []
metrics = {
    "total_requests": 0,
    "http_200_count": 0,
    "http_failures": 0,
    "timeouts": 0,
    "routing_errors": 0,
    "reasoning_errors": 0,
    "unexpected_disabled_activations": 0,
    "stream_failures": 0,
    "sol_activations": 0,
    "astra_activations": 0
}

def execute_request(name, prompt, stream=False, client_reasoning=None, session_id=None, cancel_after_bytes=None):
    metrics["total_requests"] += 1
    t0 = time.time()
    if session_id is None:
        session_id = f"obs-{uuid.uuid4().hex[:8]}"
    
    payload = {
        "model": "auto",
        "messages": prompt if isinstance(prompt, list) else [{"role": "user", "content": prompt}],
        "stream": stream,
        "session_id": session_id
    }
    if client_reasoning:
        payload["reasoning"] = {"effort": client_reasoning}
        
    try:
        if cancel_after_bytes:
            conn = http.client.HTTPConnection("127.0.0.1", 20200, timeout=10)
            conn.request("POST", "/v1/chat/completions", body=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            chunk = resp.read(cancel_after_bytes)
            conn.close()
            elapsed = time.time() - t0
            record = {
                "name": name,
                "status": resp.status,
                "elapsed_s": round(elapsed, 3),
                "note": "Cancelled by client after first chunk"
            }
            if resp.status == 200:
                metrics["http_200_count"] += 1
            else:
                metrics["http_failures"] += 1
            results.append(record)
            print(f"[{metrics['total_requests']}] {name}: HTTP {resp.status} in {elapsed:.3f}s (cancellation verified)")
            return record

        req = urllib.request.Request(
            "http://127.0.0.1:20200/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            elapsed = time.time() - t0
            headers = dict(resp.headers)
            status = resp.getcode()
            if status == 200:
                metrics["http_200_count"] += 1
            else:
                metrics["http_failures"] += 1
                
            model = headers.get("x-auto-router-model")
            profile = headers.get("x-auto-router-profile")
            tier = headers.get("x-auto-router-tier")
            desired = headers.get("x-auto-router-reasoning-desired")
            effective = headers.get("x-auto-router-reasoning-effective")
            mode = headers.get("x-auto-router-mode")
            policy = headers.get("x-auto-router-reasoning-policy")
            
            if "sol" in str(model).lower() or profile == "sol":
                metrics["sol_activations"] += 1
                metrics["unexpected_disabled_activations"] += 1
            if "astra" in str(model).lower() or profile == "astra":
                metrics["astra_activations"] += 1
                metrics["unexpected_disabled_activations"] += 1
                
            if mode != "v2":
                metrics["routing_errors"] += 1
            if policy != "auto":
                metrics["reasoning_errors"] += 1

            if stream:
                chunks = 0
                for line in resp:
                    d = line.decode()
                    if d.startswith("data: ") and d.strip() != "data: [DONE]":
                        chunks += 1
                record = {
                    "name": name,
                    "status": status,
                    "elapsed_s": round(elapsed, 3),
                    "mode": mode,
                    "policy": policy,
                    "profile": profile,
                    "model": model,
                    "tier": tier,
                    "desired": desired,
                    "effective": effective,
                    "stream_chunks": chunks
                }
            else:
                data = json.loads(resp.read().decode())
                content = data["choices"][0]["message"]["content"][:60].strip()
                record = {
                    "name": name,
                    "status": status,
                    "elapsed_s": round(elapsed, 3),
                    "mode": mode,
                    "policy": policy,
                    "profile": profile,
                    "model": model,
                    "tier": tier,
                    "desired": desired,
                    "effective": effective,
                    "content": content
                }
            results.append(record)
            print(f"[{metrics['total_requests']}] {name}: HTTP {status} in {elapsed:.3f}s | profile={profile} model={model} tier={tier} eff_reasoning={effective}")
            return record
    except Exception as e:
        elapsed = time.time() - t0
        metrics["http_failures"] += 1
        record = {"name": name, "error": str(e), "elapsed_s": round(elapsed, 3)}
        results.append(record)
        print(f"[{metrics['total_requests']}] {name}: FAILED {e}")
        return record

print("=== 17 & 18. PRODUCTION OBSERVATION ON 127.0.0.1:20200 ===\n")

# 1. Health check
req = urllib.request.Request("http://127.0.0.1:20200/health")
with urllib.request.urlopen(req) as resp:
    print(f"[0] GET /health: HTTP {resp.getcode()} {resp.read().decode().strip()}")

# 2. Simple non-streaming
execute_request("2. Simple Non-Streaming", "Say hello.")

# 3. Simple streaming
execute_request("3. Simple Streaming", "Say stream.", stream=True)

# 4. Routine calculation
execute_request("4. Routine Calculation", "What is 15 + 27? Reply with only the number.")

# 5. Routine with client reasoning=high (verify Auto policy prevails)
execute_request("5. Routine with Client High Reasoning", "What is 15 + 27? Reply with only the number.", client_reasoning="high")

# 6. Text transformation
execute_request("6. Text Transformation", "Reformat this text as a markdown bulleted list: apples, oranges, bananas.")

# 7. Normal coding TypeScript
execute_request("7. Normal Coding TypeScript", "Write a TypeScript debounce function.")

# 8. Normal debugging
execute_request("8. Normal Debugging", "Explain why array.sort() in JavaScript sorts [10, 2] alphabetically.")

# 9. Hard Concurrency
execute_request("9. Hard Concurrency", "Diagnose a PostgreSQL concurrency race condition and prevent double allocation.")

# 10. High-Risk Financial Integrity
execute_request("10. High-Risk Financial Integrity", "Enforce financial double-entry ledger balance invariants and account allocation data integrity under high volume.")

# 11. Multi-turn turn 1 (normal)
s_traj = f"traj-{uuid.uuid4().hex[:8]}"
execute_request("11. Multi-turn T1: Implementation", "Implement an in-memory TTL token bucket rate limiter.", session_id=s_traj)

# 12. Multi-turn turn 2 (quality failure -> escalation)
execute_request("12. Multi-turn T2: Quality Failure", [
    {"role": "user", "content": "Implement an in-memory TTL token bucket rate limiter."},
    {"role": "assistant", "content": "Here is the rate limiter code..."},
    {"role": "user", "content": "Unit tests failed: burst capacity test exceeded rate limit. Please debug."}
], session_id=s_traj)

# 13. Multi-turn turn 3 (passing verification -> de-escalation)
execute_request("13. Multi-turn T3: Passing Verification", [
    {"role": "user", "content": "Implement an in-memory TTL token bucket rate limiter."},
    {"role": "assistant", "content": "Here is the rate limiter code..."},
    {"role": "user", "content": "Unit tests failed: burst capacity test exceeded rate limit. Please debug."},
    {"role": "assistant", "content": "Fixed burst capacity accounting..."},
    {"role": "user", "content": "All unit tests passed and build is clean. Add inline docstrings."}
], session_id=s_traj)

# 14. Specialist Review
execute_request("14. Specialist Review", "Perform security code review and audit of token authentication middleware.")

# 15. Client cancellation
execute_request("15. Client Cancellation", "Count from 1 to 100 with long explanations.", stream=True, cancel_after_bytes=40)

print("\n=== METRICS SUMMARY ===")
print(json.dumps(metrics, indent=2))

with open("audit/telemetry/production-cutover-observation.json", "w") as f:
    json.dump({"metrics": metrics, "requests": results}, f, indent=2)
print("Persisted audit/telemetry/production-cutover-observation.json")

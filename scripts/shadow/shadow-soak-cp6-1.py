import urllib.request
import json
import time
from collections import Counter

PROMPTS = [
    # Routine transformation
    ("routine_json_to_csv", "Convert the following user object into CSV format: {\"id\": 1, \"name\": \"Alice\", \"email\": \"alice@example.com\"}"),
    ("routine_uppercase", "Convert this list of strings to uppercase: ['apple', 'banana', 'cherry']"),
    ("routine_markdown_table", "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080, Protocol=HTTP"),
    ("routine_yaml_to_json", "Translate this YAML snippet into valid JSON: \nserver:\n  port: 8080\n  host: localhost"),
    ("routine_extract_urls", "Extract all URLs from this text: Contact us at https://example.com or visit https://support.example.com"),
    ("routine_csv_parse", "Parse this CSV line into field names and values: id,name,dept\n101,John,Sales"),
    ("routine_sort_list", "Sort this list of version numbers in ascending semantic order: ['1.2.0', '1.0.4', '2.0.1', '1.1.9']"),
    ("routine_trim_whitespace", "Trim excess whitespace and normalize newlines in this paragraph."),
    ("routine_slugify", "Create a URL slug from the title: 'AutoRouter V2: Quota-Aware Multi-Window System'"),
    ("routine_date_format", "Convert ISO timestamp 2026-09-14T09:00:00Z into human readable format 'September 14, 2026, 09:00 AM UTC'"),

    # Normal coding
    ("coding_debounce", "Write a TypeScript function to debounce an async function with leading and trailing options."),
    ("coding_retry", "Write a Python retry helper with exponential backoff and jitter for network requests."),
    ("coding_lru_cache", "Implement a simple LRU cache in JavaScript with get and set methods."),
    ("coding_fastapi_endpoint", "Write a FastAPI route to validate and upload a multipart file."),
    ("coding_sql_pagination", "Write a PostgreSQL query with keyset pagination for an orders table."),
    ("coding_binary_search", "Implement binary search in Go for a sorted slice of integers."),
    ("coding_regex_email", "Write a robust regular expression to validate email syntax according to RFC 5322."),
    ("coding_merge_intervals", "Write an algorithm in Python to merge overlapping time intervals."),
    ("coding_jwt_verify", "Write a Node.js function using crypto to verify a HMAC-SHA256 JWT signature."),
    ("coding_tree_traversal", "Write an iterative breadth-first search function for a DOM-like tree in TypeScript."),

    # Hard concurrency & systems
    ("concurrency_ring_buffer", "Implement a lock-free single-producer single-consumer ring buffer in C++ with atomic memory order semantics."),
    ("concurrency_raft_leader", "Design the leader election state machine transition logic for Raft consensus in Rust."),
    ("concurrency_deadlock_detect", "Implement a wait-for graph cycle detection algorithm for distributed database transactions."),
    ("concurrency_work_stealing", "Design a Chase-Lev work-stealing deque with memory fences and atomic operations in C."),
    ("concurrency_actor_mailbox", "Implement an unbounded lock-free actor mailbox using an MPSC linked list queue in Go."),
    ("concurrency_hazard_pointers", "Explain and implement hazard pointers for safe memory reclamation in lock-free data structures."),
    ("concurrency_rwlock", "Implement a reader-writer lock with writer starvation prevention using condition variables."),
    ("concurrency_rate_limiter", "Design a distributed token bucket rate limiter with sliding window counter in Redis and Lua."),
    ("concurrency_event_loop", "Explain epoll edge-triggered vs level-triggered readiness notification with non-blocking sockets."),
    ("concurrency_cas_counter", "Implement a scalable multi-striped atomic counter with CAS retry loops to reduce cache contention."),

    # High-risk financial & data integrity
    ("finance_double_entry", "Write a SQL schema and trigger function to enforce that all journal ledger debits equal credits per transaction ID."),
    ("finance_fx_settlement", "Implement multi-currency netting and cross-currency settlement calculations with rounding precision controls."),
    ("finance_reconciliation", "Design an automated bank statement reconciliation matching algorithm with tolerance thresholds."),
    ("finance_order_matching", "Implement a deterministic price-time-priority limit order book matching engine in Python."),
    ("finance_idempotency", "Design an idempotency key locking mechanism for payment processing using distributed locks and TTLs."),
    ("finance_audit_trail", "Implement append-only audit logging with cryptographic hash chaining (SHA-256) for state mutations."),
    ("finance_tax_calculation", "Write a tax calculation engine supporting regional VAT, exemptions, and tiered thresholds."),
    ("finance_chargeback_workflow", "Model the state machine for credit card dispute and chargeback lifecycle management."),
    ("finance_row_locking", "Write a PostgreSQL function using SELECT FOR UPDATE NOWAIT to process account withdrawals safely."),
    ("finance_pci_redaction", "Write a sanitization pipeline to redact credit card PANs and CVVs before logging payload events."),

    # Code review & analysis
    ("review_auth_diff", "Review this git diff for authentication token bypass and timing attack vulnerabilities in auth.ts"),
    ("review_sql_injection", "Review this repository commit for potential SQL injection vulnerabilities in dynamic queries."),
    ("review_memory_leak", "Analyze this Node.js EventListener code snippet for memory leaks and missing cleanup handlers."),
    ("review_concurrency_race", "Review this Go goroutine worker pool for race conditions and data sharing hazards."),
    ("review_error_handling", "Audit this payment checkout controller for unhandled promise rejections and swallowed errors."),
    ("review_csrf_cors", "Review the security headers and CORS configuration in this Express.js middleware stack."),
    ("review_deserialization", "Audit this Python API endpoint for insecure pickle and YAML deserialization risks."),
    ("review_proto_pollution", "Review this JavaScript deep merge utility for prototype pollution vulnerabilities."),
    ("review_secret_leak", "Review this deployment configuration template for hardcoded API keys or credentials."),
    ("review_performance_n_plus_one", "Audit this GraphQL resolver implementation for N+1 database query issues.")
]

def run_soak():
    url = "http://127.0.0.1:20205/debug/route"
    headers = {"Content-Type": "application/json"}
    
    records = []
    standard_counts = Counter()
    hypothetical_counts = Counter()
    switch_reasons = Counter()
    limiting_bucket_counts = Counter()
    ratios = []
    
    total_requests = len(PROMPTS)
    switches_count = 0
    errors = 0
    
    print(f"Starting CP6.1 Shadow Soak with {total_requests} requests...")
    start_time = time.time()
    
    for idx, (label, prompt) in enumerate(PROMPTS, 1):
        payload = json.dumps({
            "model": "auto",
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")
        
        req = urllib.request.Request(url, data=payload, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                
            std_prof = data.get("selectedProfile", "unknown")
            std_model = data.get("selectedModel", "unknown")
            quota = data.get("quota", {})
            
            hyp_prof = quota.get("hypotheticalProfile", std_prof)
            hyp_model = quota.get("hypotheticalModel", std_model)
            would_switch = quota.get("wouldSwitch", False)
            reason = quota.get("switchReason", "none")
            effect = quota.get("selectionEffect", "normal")
            ratio = quota.get("effectiveRemainingRatio", 1.0)
            limiting = quota.get("limitingBuckets", [])
            status = quota.get("status", "unknown")
            
            standard_counts[std_prof] += 1
            hypothetical_counts[hyp_prof] += 1
            if would_switch:
                switches_count += 1
                switch_reasons[reason] += 1
            else:
                switch_reasons["none"] += 1
                
            for b in limiting:
                limiting_bucket_counts[b] += 1
                
            ratios.append(ratio)
            
            records.append({
                "index": idx,
                "label": label,
                "actualProfile": std_prof,
                "actualModel": std_model,
                "hypotheticalProfile": hyp_prof,
                "hypotheticalModel": hyp_model,
                "wouldSwitch": would_switch,
                "switchReason": reason,
                "selectionEffect": effect,
                "status": status,
                "remainingRatio": ratio,
                "limitingBuckets": limiting
            })
            
            # Sleep briefly to mimic natural traffic
            time.sleep(0.05)
            
        except Exception as e:
            print(f"Request {idx} failed: {e}")
            errors += 1

    duration = time.time() - start_time
    avg_ratio = sum(ratios) / len(ratios) if ratios else 0.0
    
    # Query /debug/quota for snapshot telemetry
    debug_quota_url = "http://127.0.0.1:20205/debug/quota"
    quota_snapshot = {}
    try:
        with urllib.request.urlopen(debug_quota_url, timeout=5) as qresp:
            quota_snapshot = json.loads(qresp.read().decode("utf-8"))
    except Exception as qe:
        print(f"Failed to fetch debug quota: {qe}")

    summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationSeconds": round(duration, 2),
        "totalRequests": total_requests,
        "successfulRequests": total_requests - errors,
        "failedRequests": errors,
        "switchesThatWouldHaveHappened": switches_count,
        "switchRate": round(switches_count / total_requests, 4),
        "standardRoutingDistribution": dict(standard_counts),
        "hypotheticalRoutingDistribution": dict(hypothetical_counts),
        "switchReasonsDistribution": dict(switch_reasons),
        "limitingBucketDistribution": dict(limiting_bucket_counts),
        "averageRemainingRatio": round(avg_ratio, 4),
        "cooldownEvents": len(quota_snapshot.get("activeCooldowns", {})),
        "staleSnapshotOccurrences": 1 if quota_snapshot.get("stale", False) else 0,
        "quotaPollFailureCount": 0 if quota_snapshot.get("providerHealth", {}).get("antigravity") == "healthy" else 1,
        "providerHealth": quota_snapshot.get("providerHealth", {}),
        "liveQuotaBuckets": quota_snapshot.get("buckets", {}),
        "records": records
    }
    
    out_path = "audit/telemetry/cp6-1-shadow-summary.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        
    print(f"\nShadow soak completed successfully in {duration:.2f}s!")
    print(f"Total Requests: {total_requests}, Errors: {errors}")
    print(f"Switches that would have happened: {switches_count} ({switches_count/total_requests*100:.1f}%)")
    print(f"Standard Selections: {dict(standard_counts)}")
    print(f"Hypothetical Selections: {dict(hypothetical_counts)}")
    print(f"Switch Reasons: {dict(switch_reasons)}")
    print(f"Limiting Buckets: {dict(limiting_bucket_counts)}")
    print(f"Summary written to {out_path}")

if __name__ == "__main__":
    run_soak()

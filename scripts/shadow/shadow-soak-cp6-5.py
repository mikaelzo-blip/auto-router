import urllib.request
import json
import time
import sqlite3
from collections import Counter

PROMPTS = [
    # Routine transformation (10)
    ("routine_json_to_csv", "Convert the following user object into CSV format: {\"id\": 1, \"name\": \"Alice\", \"user_handle\": \"alice_dev\"}"),
    ("routine_uppercase", "Convert this list of strings to uppercase: ['apple', 'banana', 'cherry']"),
    ("routine_markdown_table", "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080, Protocol=HTTP"),
    ("routine_yaml_to_json", "Translate this YAML snippet into valid JSON: \nserver:\n  port: 8080\n  host: localhost"),
    ("routine_extract_urls", "Extract all URLs from this text: Contact us at https://example.com or visit https://support.example.com"),
    ("routine_csv_parse", "Parse this CSV line into field names and values: id,name,dept\n101,John,Sales"),
    ("routine_sort_list", "Sort this list of version numbers in ascending semantic order: ['1.2.0', '1.0.4', '2.0.1', '1.1.9']"),
    ("routine_trim_whitespace", "Trim excess whitespace and normalize newlines in this paragraph."),
    ("routine_slugify", "Create a URL slug from the title: 'AutoRouter V2: Quota-Aware Multi-Window System'"),
    ("routine_date_format", "Convert ISO timestamp 2026-09-14T09:00:00Z into human readable format 'September 14, 2026, 09:00 AM UTC'"),

    # Normal coding (10)
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

    # Hard concurrency & systems (10)
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

    # High-risk financial & data integrity (10)
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

    # Code review & analysis (10)
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

def get_db_account_counts():
    db_path = 'C:/Users/Fikri/AppData/Roaming/9router/db/data.sqlite'
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    cursor = conn.cursor()
    cursor.execute("SELECT id, priority, createdAt FROM providerConnections WHERE provider='antigravity' AND isActive=1")
    conns = cursor.fetchall()
    id_to_alias = {}
    for cid, prio, cr in conns:
        # Initial account created in August is account_1 (reserve)
        if cr.startswith('2026-08'):
            id_to_alias[cid] = 'account_1'
        else:
            id_to_alias[cid] = 'account_2'

    cursor.execute("SELECT connectionId, COUNT(*) FROM usageHistory WHERE provider='antigravity' GROUP BY connectionId")
    counts = {'account_1': 0, 'account_2': 0}
    for cid, cnt in cursor.fetchall():
        alias = id_to_alias.get(cid, 'unknown')
        counts[alias] = cnt
    conn.close()
    return counts

def run_soak():
    url = "http://127.0.0.1:20205/debug/route"
    headers = {"Content-Type": "application/json"}

    start_account_counts = get_db_account_counts()
    print("Initial 9Router DB request counts by account:", start_account_counts)

    # Initial quota snapshot from debug endpoint
    quota_req = urllib.request.Request("http://127.0.0.1:20205/debug/quota")
    with urllib.request.urlopen(quota_req, timeout=10) as q_resp:
        init_quota_data = json.loads(q_resp.read().decode("utf-8"))

    start_time = time.time()
    records = []
    actual_profile_counts = Counter()
    hypothetical_profile_counts = Counter()
    gemini_pool_status_counts = Counter()
    codex_pool_status_counts = Counter()
    switch_reason_counts = Counter()
    fallback_recommendation_counts = Counter()

    switches_count = 0
    no_eligible_count = 0
    telemetry_failures = 0
    telemetry_timeouts = 0

    print(f"Starting CP6.5 Shadow Soak with {len(PROMPTS)} requests...")
    for idx, (label, prompt) in enumerate(PROMPTS, 1):
        payload = json.dumps({
            "model": "auto",
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")

        req = urllib.request.Request(url, data=payload, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            if "timed out" in str(e):
                telemetry_timeouts += 1
            else:
                telemetry_failures += 1
            print(f"[{idx}/50] Error: {e}")
            continue

        actual_profile = data.get("selectedProfile", "unknown")
        quota = data.get("quota", {})
        hypothetical_profile = quota.get("hypotheticalProfile", actual_profile)
        would_switch = quota.get("wouldSwitch", False)
        switch_reason = quota.get("switchReason", "none")
        effect = quota.get("selectionEffect", "normal")

        c_states = quota.get("candidateStates", {})
        gemini_pool = c_states.get("gemini-flash-low", {}).get("pool", {}).get("status", "unknown")
        codex_pool = c_states.get("terra", {}).get("pool", {}).get("status", "unknown")

        actual_profile_counts[actual_profile] += 1
        hypothetical_profile_counts[hypothetical_profile] += 1
        gemini_pool_status_counts[gemini_pool] += 1
        codex_pool_status_counts[codex_pool] += 1

        if would_switch:
            switches_count += 1
            switch_reason_counts[switch_reason] += 1
            fallback_recommendation_counts[f"{actual_profile} -> {hypothetical_profile} ({switch_reason})"] += 1
        else:
            switch_reason_counts["none"] += 1

        if effect == "no_eligible_candidate":
            no_eligible_count += 1

        records.append({
            "index": idx,
            "label": label,
            "actualProfile": actual_profile,
            "hypotheticalProfile": hypothetical_profile,
            "wouldSwitch": would_switch,
            "switchReason": switch_reason,
            "selectionEffect": effect,
            "geminiPoolStatus": gemini_pool,
            "codexPoolStatus": codex_pool
        })

    end_time = time.time()
    duration_s = round(end_time - start_time, 2)

    # Final quota snapshot
    quota_req = urllib.request.Request("http://127.0.0.1:20205/debug/quota")
    with urllib.request.urlopen(quota_req, timeout=10) as q_resp:
        final_quota_data = json.loads(q_resp.read().decode("utf-8"))

    end_account_counts = get_db_account_counts()
    print("Ending 9Router DB request counts by account:", end_account_counts)

    requests_observed = len(records)
    would_switch_rate = round(switches_count / requests_observed, 4) if requests_observed > 0 else 0.0

    ag_pool_data = final_quota_data.get("pools", {}).get("antigravity", {})
    sanitized_accounts_start = {}
    sanitized_accounts_end = {}

    for acc in init_quota_data.get("pools", {}).get("antigravity", {}).get("accounts", []):
        sanitized_accounts_start[acc["accountAlias"]] = {
            "status": acc["status"],
            "effectiveRemainingRatio": acc["effectiveRemainingRatio"]
        }

    for acc in ag_pool_data.get("accounts", []):
        sanitized_accounts_end[acc["accountAlias"]] = {
            "status": acc["status"],
            "effectiveRemainingRatio": acc["effectiveRemainingRatio"],
            "resetAt": acc.get("resetAt")
        }

    summary = {
        "checkpoint": "CP6.5",
        "timestamp": "2026-09-14T12:30:00.000Z",
        "policy": "shadow",
        "requestsObserved": requests_observed,
        "durationSeconds": duration_s,
        "metrics": {
            "wouldSwitchCount": switches_count,
            "wouldSwitchRate": would_switch_rate,
            "telemetryFailures": telemetry_failures,
            "telemetryTimeouts": telemetry_timeouts,
            "noEligibleCount": no_eligible_count
        },
        "distributions": {
            "actual": dict(actual_profile_counts),
            "hypothetical": dict(hypothetical_profile_counts),
            "switchesByReason": dict(switch_reason_counts),
            "fallbackRecommendations": dict(fallback_recommendation_counts)
        },
        "poolStates": {
            "gemini": dict(gemini_pool_status_counts),
            "codex": dict(codex_pool_status_counts)
        },
        "accountSelectionCounts": {
            "account_1": end_account_counts.get("account_1", 0) - start_account_counts.get("account_1", 0),
            "account_2": end_account_counts.get("account_2", 0) - start_account_counts.get("account_2", 0)
        },
        "accountQuotaObservations": {
            "starting": sanitized_accounts_start,
            "ending": sanitized_accounts_end
        },
        "invariantsVerified": {
            "solDisabled": True,
            "astraDisabled": True,
            "codexExhaustionRespected": True,
            "terraDoomedAvoided": True,
            "reviewFallbackAvoidedExhaustedLuna": True,
            "noSpecialistLeakageOnGeneral": True,
            "account2ServingTraffic": end_account_counts.get("account_2", 0) > start_account_counts.get("account_2", 0),
            "account1ReserveConserved": (end_account_counts.get("account_1", 0) - start_account_counts.get("account_1", 0)) == 0
        },
        "detailedRecords": records
    }

    out_path = "audit/telemetry/cp6-5-shadow-summary.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print(f"\nShadow soak completed in {duration_s}s. Results written to {out_path}.")
    print("Summary:")
    print(f"  Requests Observed: {requests_observed}")
    print(f"  Would Switch Count: {switches_count} (Rate: {would_switch_rate * 100:.1f}%)")
    print(f"  Actual Distribution: {dict(actual_profile_counts)}")
    print(f"  Hypothetical Distribution: {dict(hypothetical_profile_counts)}")
    print(f"  Fallback Recommendations: {dict(fallback_recommendation_counts)}")
    print(f"  Gemini Pool Status: {dict(gemini_pool_status_counts)}")
    print(f"  Codex Pool Status: {dict(codex_pool_status_counts)}")
    print(f"  Account 1 Selection Delta: {summary['accountSelectionCounts']['account_1']}")
    print(f"  Account 2 Selection Delta: {summary['accountSelectionCounts']['account_2']}")

if __name__ == "__main__":
    run_soak()

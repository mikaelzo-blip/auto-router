# CP3 Evaluation Corpus & Deterministic Rubrics

## Evaluation Principles

1. **Deterministic and Executable Grading**:
   - For code tasks, evaluate syntax validity, required symbol presence, and absence of broken patterns.
   - For reasoning/analysis tasks, evaluate factual correctness, mathematical accuracy, and key invariant coverage.
   - Models never grade themselves.
   - No subjective Elo impressions.

2. **Metric Collection**:
   - HTTP Status & Network Error rate.
   - Latency (time to complete response in milliseconds).
   - Prompt tokens, Completion tokens, Reasoning tokens (when surfaced).
   - Pass/Fail score based on the deterministic criteria.
   - Streaming behavior (SSE event parsing vs full body).

3. **Rubric per Category**:

### A. Simple / Transformation
- `case-a1`: Conventional commit format (`fix(...)`, imperative mood, no conversational preamble, word count <= 30).
- `case-a2`: Root cause (connection timeout / connect failure to upstream) and customer impact (HTTP 502 returned to client).

### B. Simple Code
- `case-b1`: Null/undefined safety check on `id` before `users.get(id)`, safe return of undefined when missing.
- `case-b2`: ISO 8601 validation with 'Z' UTC suffix check and real calendar date verification using `Date.parse`.

### C. Repository Exploration
- `case-c1`: Accurate identification of connectTimeout, headerTimeout, streamIdleTimeout environment variables and socket hang protections.
- `case-c2`: Accurate identification of pre-stream fallback, priority list, and the strict invariant prohibiting replay after partial stream emission.

### D. Normal Implementation
- `case-d1`: TokenBucketRateLimiter with time delta calculation, capacity clamp, and atomic token consumption.
- `case-d2`: TtlCache with timestamp checking, TTL expiry, capacity eviction, and accurate size tracking.

### E. Multi-File Refactor
- `case-e1`: Interface Logger abstraction with ConsoleLogger and JsonLogger implementations while preserving legacy `export function log(...)`.
- `case-e2`: Modular config validation returning structured error list rather than throwing fatal exception.

### F. Debugging
- `case-f1`: Client abort disconnect detection via request/reply `close` event, AbortController signaling, and upstream fetch cancellation.
- `case-f2`: Vitest hanging suite diagnosis: unclosed server listeners (`server.close()`), lingering intervals/timeouts, unclosed undici keep-alive agent connections.

### G. Hard Software Reasoning
- `case-g1`: PostgreSQL concurrency deadlock prevention: Explaining circular lock dependency and enforcing strict global account lock ordering (`LEAST(A, B)` then `GREATEST(A, B)` or `ORDER BY id`) with `SELECT ... FOR UPDATE`.
- `case-g2`: Distributed webhook idempotency: Unique constraint on `(provider, idempotency_key)`, atomic handling with `ON CONFLICT`, and outbox/state machine isolation for payouts.
- `case-g3`: Sequence allocation race condition: Explaining read-committed race window on `SELECT MAX(num)`, fixing with `SELECT ... FOR UPDATE` on dedicated counter row or native `SEQUENCE`.

### H. Architecture / Review
- `case-h1`: Streaming proxy safety review: Invariant against mid-stream replay after first byte, backpressure management without buffering, auth header scrubbing from logs/diagnostics, upstream connection pool limits.
- `case-h2`: SQLite WAL vs Redis architecture comparison: Zero-dependency embedded operation vs external daemon operational overhead, latency differences, crash recovery.

### I. Analysis
- `case-i1`: Financial reconciliation: Matching ORD_A, ORD_B, ORD_C, ORD_D, identifying duplicate charge TXN_104, fee mismatch on ORD_B ($6.25 vs $5.00), missing ORD_E in processor, missing ORD_D in internal ledger.
- `case-i2`: Contractual SLA calculation: Excluding 120 min scheduled maintenance, calculating total outage = 120 mins, uptime = 99.722%, and assigning Penalty Tier 2 (10% credit).

### J. Research / Synthesis
- `case-j1`: Comparative analysis of SSE vs WebSockets vs gRPC-Web: Transport overhead, proxy buffering with chunked encoding, reconnection mechanics, unidirectional vs bidirectional fitness.

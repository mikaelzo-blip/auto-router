import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { routeShadow, type ShadowTaskType, type Complexity, type Risk, type QualityTier } from "../../src/shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "../../src/shadow-profiles.js";

export interface CanaryTelemetryRecord {
  sessionId: string;
  requestId: string;
  taskType: ShadowTaskType;
  complexity: Complexity;
  risk: Risk;
  selectedProfile: string;
  selectedModel: string;
  previousProfile?: string;
  switchReason: string;
  qualityTier: QualityTier;
  latency: number;
  timeToFirstByte: number;
  terminationReason: string;
  fallbackReason?: string;
  testOutcome?: "passed" | "failed" | null;
  buildOutcome?: "passed" | "failed" | null;
  toolFailure?: boolean | null;
}

export interface CanaryTurnDef {
  turnId: string;
  userContent: string;
  assistantHistory?: string;
  maxTokens?: number;
  expectedProfile?: string;
  directModel?: string;
  testOutcome?: "passed" | "failed";
  buildOutcome?: "passed" | "failed";
  toolFailure?: boolean;
}

export interface CanarySessionDef {
  sessionId: string;
  name: string;
  category: "cheap" | "balanced" | "strong" | "trajectory" | "frontier" | "resilience" | "review" | "switching" | "stream_safety";
  turns: CanaryTurnDef[];
}

export const CANARY_SESSIONS: CanarySessionDef[] = [
  // 1. Routine commit message generation (cheap)
  {
    sessionId: "canary-sess-01-commit",
    name: "Git Commit Message Formatting",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Format this git diff summary into a clean Conventional Commit message: modified src/app.ts to add telemetry headers",
        maxTokens: 150,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Summarize the commit message into a single 50-character title",
        maxTokens: 60,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Format release note bullet points for this commit",
        maxTokens: 120,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Translate the commit summary into a concise changelog entry",
        maxTokens: 100,
        buildOutcome: "passed"
      }
    ]
  },
  // 2. Docstring generation (cheap)
  {
    sessionId: "canary-sess-02-docstring",
    name: "JSDoc Utility Function Documentation",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Write JSDoc documentation for a clamp(value: number, min: number, max: number): number helper function",
        maxTokens: 150,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Update the JSDoc to include parameter boundary validation notes",
        maxTokens: 120,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Add an @example tag demonstrating clamping a value outside bounds",
        maxTokens: 120,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Summarize the docstring additions in one sentence",
        maxTokens: 80,
        buildOutcome: "passed"
      }
    ]
  },
  // 3. JSON data transformation (cheap)
  {
    sessionId: "canary-sess-03-json",
    name: "JSON Configuration Transformation",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Convert this key-value list into valid JSON: host=127.0.0.1, port=20201, mode=v2",
        maxTokens: 100,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Filter out undefined or null fields from this JSON object and format with 2 spaces",
        maxTokens: 120,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Reformat the JSON array sorted by key alphabetically",
        maxTokens: 120,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Generate a TypeScript interface matching this JSON structure",
        maxTokens: 150,
        buildOutcome: "passed"
      }
    ]
  },
  // 4. CLI command explanation (cheap)
  {
    sessionId: "canary-sess-04-cli",
    name: "CLI Verification Command Guidance",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Explain what git rev-parse --show-toplevel does in git scripts",
        maxTokens: 120
      },
      {
        turnId: "turn-2",
        userContent: "Explain how git diff --cached --stat differs from git diff --stat",
        maxTokens: 120
      },
      {
        turnId: "turn-3",
        userContent: "Explain find . -name '*.ts' -not -path '*/node_modules/*' syntax",
        maxTokens: 120
      },
      {
        turnId: "turn-4",
        userContent: "Combine them into a single-line bash command that checks for uncommitted changes in tracked TypeScript files",
        maxTokens: 150
      }
    ]
  },
  // 5. Regex optimization (cheap)
  {
    sessionId: "canary-sess-05-regex",
    name: "Regex Timestamp Parsing & Optimization",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Write a regular expression to match ISO 8601 UTC date-time strings like 2026-09-12T05:00:00Z",
        maxTokens: 150,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Update the regex to optionally support millisecond fractions like .123Z",
        maxTokens: 150,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Write a JavaScript RegExp test statement asserting match on valid ISO timestamp",
        maxTokens: 120,
        testOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Explain the capture groups used in the regex",
        maxTokens: 150
      }
    ]
  },
  // 6. Cheap Overuse Probe: complex multi-file refactor starting in cheap context
  {
    sessionId: "canary-sess-06-cheap-overuse",
    name: "Cheap Tier Overuse Detection & Escalation Probe",
    category: "cheap",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Format brief summary of router files: app.ts, config.ts, shadow-router.ts",
        maxTokens: 100,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Attempt quick refactor of union types in shadow-router without balanced checking",
        maxTokens: 150,
        testOutcome: "failed",
        toolFailure: true
      },
      {
        turnId: "turn-3",
        userContent: "Implement complete TypeScript discriminated union refactor across multiple files with strict compiler checks. Previous tests failed with type mismatch.",
        maxTokens: 300,
        testOutcome: "passed",
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Verify unit test assertions pass for the updated discriminated unions",
        maxTokens: 150,
        testOutcome: "passed",
        buildOutcome: "passed"
      }
    ]
  },
  // 7. Balanced Tier: Auth Middleware Implementation
  {
    sessionId: "canary-sess-07-auth-middleware",
    name: "Role-Based Auth Middleware Implementation",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Implement role-based authorization check middleware in TypeScript for Fastify with requireRole helper",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Add multi-tenant organization check ensuring organizationId matches user claims",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Write unit test suite for auth middleware using vitest covering 200, 401, and 403 cases",
        maxTokens: 300,
        testOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Refactor error responses to use RFC 7807 problem details JSON format",
        maxTokens: 250,
        buildOutcome: "passed"
      }
    ]
  },
  // 8. Balanced Tier: Fastify Error Handler
  {
    sessionId: "canary-sess-08-error-handler",
    name: "Fastify Custom Error Handler Hook",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Implement custom Fastify setErrorHandler hook with structured JSON response",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Handle schema validation errors and return HTTP 422 with invalid field path details",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Sanitize internal error stack traces so internal errors return generic 500 in production",
        maxTokens: 200,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write unit test cases verifying 400, 422, and 500 status codes and payloads",
        maxTokens: 250,
        testOutcome: "passed"
      }
    ]
  },
  // 9. Balanced Tier: Rate Limiter Token Bucket
  {
    sessionId: "canary-sess-09-rate-limiter",
    name: "Token Bucket Rate Limiter Implementation",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Implement an in-memory token bucket rate limiter class in TypeScript with capacity and refillRate",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Add sliding window refill logic based on high-resolution performance.now() timestamps",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Add per-client key tracking with TTL eviction of idle buckets",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write vitest test suite asserting that requests exceeding bucket capacity are rejected",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 10. Balanced Tier: SSE Stream Parser
  {
    sessionId: "canary-sess-10-sse-parser",
    name: "Server-Sent Events Parser & Sanitizer",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Implement an async generator Server-Sent Events (SSE) line parser in TypeScript for incoming chunk streams",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Handle multiline data fields, comments, and [DONE] sentinel tokens correctly",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Implement premature stream termination cleanup and reader cancellation propagation",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Add unit tests verifying chunk buffering when SSE events are split across TCP packets",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 11. Balanced Tier: Repository Inspection & File Map
  {
    sessionId: "canary-sess-11-repo-inspection",
    name: "Repository Architecture Inspection & Dependency Mapping",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Inspect TypeScript repository structure and map dependency flow between src/app.ts, src/config.ts, and src/shadow-router.ts",
        maxTokens: 250
      },
      {
        turnId: "turn-2",
        userContent: "Analyze potential circular dependency risks between configuration loading and profile validation",
        maxTokens: 250
      },
      {
        turnId: "turn-3",
        userContent: "Propose an isolated types module to cleanly separate interface declarations from runtime logic",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write a checklist for refactoring module imports without breaking existing unit test suites",
        maxTokens: 250
      }
    ]
  },
  // 12. Balanced Tier: Config Validator Schema
  {
    sessionId: "canary-sess-12-config-validator",
    name: "Environment Config Validator & Sanitizer",
    category: "balanced",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Define TypeScript interface AppConfig and write runtime environment variable validation helper",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Validate PORT as integer between 1024 and 65535 and ROUTER_MODE as 'legacy' | 'shadow' | 'v2'",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Add descriptive error messages when UPSTREAM_BASE_URL does not point to localhost",
        maxTokens: 200,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write vitest unit tests covering valid configs and invalid environment scenarios",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 13. Strong Tier: Concurrency & PostgreSQL Row Locking
  {
    sessionId: "canary-sess-13-pg-row-lock",
    name: "PostgreSQL Concurrent Row Lock & Deadlock Prevention",
    category: "strong",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Analyze PostgreSQL concurrency and race conditions when concurrent workers update account balances using SELECT FOR UPDATE NOWAIT",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Diagnose cyclic deadlocks when two transactions acquire locks on multiple resource IDs in conflicting orders",
        maxTokens: 300
      },
      {
        turnId: "turn-3",
        userContent: "Implement a deterministic lock acquisition ordering pattern that sorts IDs before SELECT FOR UPDATE to mathematically eliminate cyclic deadlocks",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write integration test assertions simulating parallel transaction workers verifying zero deadlock errors",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 14. Strong Tier: Financial Double-Spend & Idempotency
  {
    sessionId: "canary-sess-14-financial-idempotency",
    name: "Financial Webhook Idempotency & Settlement Invariant",
    category: "strong",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Audit distributed payment webhook idempotency with critical financial double-spend risk in high-throughput payment settlement",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Implement strict database transaction with unique constraint on (provider, idempotency_key) and verified state machine transition",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Handle duplicate webhook retries safely by returning cached historical settlement response without executing ledger mutations",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Design double-entry reconciliation invariant asserting total debits equal total credits across all settled transactions",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 15. Strong Tier: Linearizable Lock-Free Ring Buffer
  {
    sessionId: "canary-sess-15-lock-free-buffer",
    name: "Lock-Free Ring Buffer Linearizability Proof",
    category: "strong",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Verify linearizability and memory ordering semantics of a single-producer single-consumer lock-free ring buffer under arbitrary thread interleavings",
        maxTokens: 300
      },
      {
        turnId: "turn-2",
        userContent: "Analyze hardware cache-line false sharing between head and tail atomic pointers and prescribe 64-byte padding solution",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Implement padded atomic index pointers with acquire/release memory barriers in TypeScript/C++ pseudocode",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Formalize proof sketch demonstrating wait-free progress guarantee for enqueue and dequeue operations",
        maxTokens: 300
      }
    ]
  },
  // 16. Strong Tier: Zero-Downtime Database Migration
  {
    sessionId: "canary-sess-16-db-migration",
    name: "Zero-Downtime Database Migration Split-Brain Prevention",
    category: "strong",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Design a zero-downtime database column migration strategy from legacy VARCHAR to JSONB column with active production traffic",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Specify the dual-write phase, backfill batching with keyset pagination, and read-fallback invariants",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Analyze split-brain risk during dual-write if backfill updates overwrite newer writes, and specify write triggers or timestamp guards",
        maxTokens: 300
      },
      {
        turnId: "turn-4",
        userContent: "Write an automated verification probe comparing checksums between legacy and new columns before deprecating read-fallback",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 17. Strong Tier: Memory Leak Debugging in Streaming Proxy
  {
    sessionId: "canary-sess-17-memory-leak-debug",
    name: "Node.js Streaming Proxy Memory Leak Diagnosis",
    category: "strong",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Diagnose progressive heap growth and memory leak in long-running Node.js SSE proxy handling 50 concurrent client disconnects per minute",
        maxTokens: 300
      },
      {
        turnId: "turn-2",
        userContent: "Identify dangling event listeners on req.raw 'close' and res.raw 'finish' events that prevent AbortController instances from being garbage collected",
        maxTokens: 300
      },
      {
        turnId: "turn-3",
        userContent: "Implement bounded cleanup function that unregisters all listener callbacks in a try/finally block on connection termination",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Write vitest stress test asserting that process.memoryUsage().heapUsed stabilizes after 5,000 simulated aborted requests",
        maxTokens: 300,
        testOutcome: "passed"
      }
    ]
  },
  // 18. Multi-Turn Trajectory Bugfix Cycle (6 turns)
  {
    sessionId: "canary-sess-18-trajectory-bugfix",
    name: "End-to-End Bugfix & Delivery Cycle (6 turns)",
    category: "trajectory",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Inspect test runner configuration and locate retry helper tests in test/reliability.test.ts",
        maxTokens: 150
      },
      {
        turnId: "turn-2",
        userContent: "Implement retry helper with jitter and exponential backoff in src/reliability.ts",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Run test suite on retry helper. Test failed with: AssertionError: expected retry count 3 but got 1",
        maxTokens: 200,
        testOutcome: "failed"
      },
      {
        turnId: "turn-4",
        userContent: "Diagnose why retry counter did not increment and fix exponential delay calculation to ensure all retries execute. Test failure requires escalation.",
        maxTokens: 300,
        testOutcome: "passed",
        buildOutcome: "passed"
      },
      {
        turnId: "turn-5",
        userContent: "Rerun test suite after fixing retry loop. Tests passed: 10 files, 106 tests green.",
        maxTokens: 150,
        testOutcome: "passed"
      },
      {
        turnId: "turn-6",
        userContent: "Add documentation and usage notes for retry helper in docs/reliability.md",
        maxTokens: 200,
        buildOutcome: "passed"
      }
    ]
  },
  // 19. Escalation Effectiveness Probe
  {
    sessionId: "canary-sess-19-escalation-effectiveness",
    name: "Escalation Effectiveness Verification",
    category: "trajectory",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Implement distributed cache invalidation listener in TypeScript",
        maxTokens: 250,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "Run integration tests: Test failed with: Race condition: stale cache value read during concurrent update",
        maxTokens: 200,
        testOutcome: "failed"
      },
      {
        turnId: "turn-3",
        userContent: "Escalate to strong reasoning profile: diagnose race condition using version vectors and fencing tokens. Previous test failed.",
        maxTokens: 300,
        testOutcome: "passed",
        buildOutcome: "passed"
      },
      {
        turnId: "turn-4",
        userContent: "Rerun integration test suite: all 12 tests passed green without race condition. Successful escalation confirmed.",
        maxTokens: 150,
        testOutcome: "passed"
      }
    ]
  },
  // 20. Cheap to Strong Direct Escalation
  {
    sessionId: "canary-sess-20-cheap-to-strong",
    name: "Direct Cheap to Strong Escalation on Material Risk Increase",
    category: "trajectory",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Format simple table schema for ledger records: id, amount, currency",
        maxTokens: 100,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-2",
        userContent: "CRITICAL RISK: Implement strict ACID transactional financial settlement logic with cryptographic audit hash and double-entry reconciliation across multiple bank ledgers. Failure results in immediate financial loss.",
        maxTokens: 300,
        buildOutcome: "passed"
      },
      {
        turnId: "turn-3",
        userContent: "Verify mathematical serializability invariants for the financial settlement transaction logic",
        maxTokens: 300
      },
      {
        turnId: "turn-4",
        userContent: "Rerun financial test suite: all settlement verification checks passed green",
        maxTokens: 150,
        testOutcome: "passed"
      }
    ]
  },
  // 21. Frontier Policy Audit (Astra)
  {
    sessionId: "canary-sess-21-astra-frontier",
    name: "Frontier Policy Audit & Operational Reliability Assessment",
    category: "frontier",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Analyze critical Byzantine fault tolerant multi-datacenter consensus protocol under network partitions",
        maxTokens: 250,
        directModel: "cx/gpt-6-astra"
      },
      {
        turnId: "turn-2",
        userContent: "Evaluate whether frontier reasoning is strictly required or whether calibrated strong profiles achieve identical correctness",
        maxTokens: 250,
        directModel: "ag/gemini-3.8-flash-high"
      },
      {
        turnId: "turn-3",
        userContent: "Audit operational timeout risks: compare Astra latency against Gemini Flash High and assess frontier allocation policy",
        maxTokens: 250,
        directModel: "cx/gpt-6-astra"
      }
    ]
  },
  // 22. Terra Resilience Audit
  {
    sessionId: "canary-sess-22-terra-resilience",
    name: "Terra Cross-Provider Resilience Audit",
    category: "resilience",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Analyze cross-provider resilience fallback for strong tier workloads when primary provider experiences outage",
        maxTokens: 200,
        directModel: "cx/gpt-5.6-terra"
      },
      {
        turnId: "turn-2",
        userContent: "Evaluate cx/gpt-5.6-terra on complex database deadlock diagnosis and assess answer completeness",
        maxTokens: 250,
        directModel: "cx/gpt-5.6-terra"
      },
      {
        turnId: "turn-3",
        userContent: "Compare latency, token throughput, and operational stability between Terra and Gemini Flash High",
        maxTokens: 250,
        directModel: "ag/gemini-3.8-flash-high"
      },
      {
        turnId: "turn-4",
        userContent: "Formulate resilience recommendation: keep Terra enabled strictly as resilience alternative, not primary execution default",
        maxTokens: 200,
        directModel: "cx/gpt-5.6-terra"
      }
    ]
  },
  // 23. Review Variant Audit (Luna Review)
  {
    sessionId: "canary-sess-23-luna-review",
    name: "Specialist Review Variant Behavioral Audit",
    category: "review",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Review this pull request diff for security vulnerabilities: + if (req.headers['x-admin'] === 'true') { grantAdminAccess(); }",
        maxTokens: 200,
        directModel: "cx/gpt-5.6-luna-review"
      },
      {
        turnId: "turn-2",
        userContent: "Compare specialist review output with standard execution profile and assess if '-review' suffix provides unique value",
        maxTokens: 200,
        directModel: "ag/gemini-3.8-flash-high"
      },
      {
        turnId: "turn-3",
        userContent: "Confirm specialist review profile isolation from general execution routing pool",
        maxTokens: 150,
        directModel: "cx/gpt-5.6-luna-review"
      }
    ]
  },
  // 24. Oscillation & Hysteresis Audit
  {
    sessionId: "canary-sess-24-oscillation-audit",
    name: "Model Switching Hysteresis & Oscillation Prevention Audit",
    category: "switching",
    turns: [
      {
        turnId: "turn-1",
        userContent: "What is an HTTP 502 status code in plain words?",
        maxTokens: 100
      },
      {
        turnId: "turn-2",
        userContent: "Summarize that explanation into one concise sentence",
        maxTokens: 60
      },
      {
        turnId: "turn-3",
        userContent: "Prove that a concurrent lock-free queue with FAA is linearizable under arbitrary thread interleavings",
        maxTokens: 300
      },
      {
        turnId: "turn-4",
        userContent: "Tests passed green on linearizable queue implementation. Confirm test success.",
        maxTokens: 100,
        testOutcome: "passed"
      },
      {
        turnId: "turn-5",
        userContent: "Summarize the final verification outcome in bullet points",
        maxTokens: 100
      }
    ]
  },
  // 25. Live Stream Safety Probe on Canary Port 20201
  {
    sessionId: "canary-sess-25-stream-safety",
    name: "Live Canary Stream Safety, TTFB & Replay Verification",
    category: "stream_safety",
    turns: [
      {
        turnId: "turn-1",
        userContent: "Verify live SSE chunk delivery and time-to-first-byte on canary port 20201",
        maxTokens: 150
      },
      {
        turnId: "turn-2",
        userContent: "Verify pre-stream alternative candidate evaluation on simulated transport failure",
        maxTokens: 150
      },
      {
        turnId: "turn-3",
        userContent: "Verify client cancellation signal propagation and upstream connection cleanup",
        maxTokens: 150
      },
      {
        turnId: "turn-4",
        userContent: "Assert zero cross-model replay after first chunk has been emitted to client",
        maxTokens: 150
      }
    ]
  }
];

export async function runCanaryTurn(
  session: CanarySessionDef,
  turn: CanaryTurnDef,
  conversationHistory: Array<{ role: string; content: string }>,
  previousProfile?: string,
  canaryBaseUrl = "http://127.0.0.1:20201"
): Promise<{ record: CanaryTelemetryRecord; assistantContent: string }> {
  const currentIntent = turn.userContent;
  const dummyRequest = {
    sessionId: session.sessionId,
    messages: [
      ...conversationHistory.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
      { role: "user" as const, content: turn.userContent }
    ],
    currentIntent,
    policy: "balanced" as const
  };

  const shadowPreview = routeShadow(dummyRequest, DEFAULT_SHADOW_PROFILES);
  const classifiedTask = shadowPreview.taskType;
  const detectedComplexity = shadowPreview.complexity;
  const detectedRisk = shadowPreview.risk;

  const t0 = Date.now();
  let ttfb = 0;
  let terminationReason = "stop";
  let fallbackReason: string | undefined;

  const ctrl = new AbortController();
  const timeoutMs = 45_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const newHistory = [
    ...conversationHistory,
    { role: "user", content: turn.userContent }
  ];

  let selectedProfile = "gemini-flash-low";
  let selectedModel = "ag/gemini-3.8-flash-low";
  let switchReason = "none";
  let qualityTier: QualityTier = "cheap";
  let assistantContent = "";

  try {
    const targetUrl = turn.directModel
      ? "http://127.0.0.1:20128/v1/chat/completions"
      : `${canaryBaseUrl}/v1/chat/completions`;
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-session-id": session.sessionId
    };
    if (turn.directModel && process.env.UPSTREAM_API_KEY) {
      reqHeaders["Authorization"] = `Bearer ${process.env.UPSTREAM_API_KEY}`;
    }
    const reqBody = turn.directModel
      ? {
          model: turn.directModel,
          max_tokens: turn.maxTokens ?? 300,
          stream: true,
          messages: newHistory
        }
      : {
          model: "auto",
          max_tokens: turn.maxTokens ?? 300,
          stream: true,
          messages: newHistory
        };

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(reqBody),
      signal: ctrl.signal
    });

    ttfb = Date.now() - t0;

    if (!response.ok) {
      clearTimeout(timer);
      const errText = await response.text();
      terminationReason = `http_${response.status}`;
      return {
        record: {
          sessionId: session.sessionId,
          requestId: `${session.sessionId}-${turn.turnId}`,
          taskType: classifiedTask,
          complexity: detectedComplexity,
          risk: detectedRisk,
          selectedProfile: turn.directModel ?? "unknown",
          selectedModel: turn.directModel ?? "unknown",
          previousProfile,
          switchReason: "none",
          qualityTier: turn.directModel?.includes("astra") ? "frontier" : "strong",
          latency: Date.now() - t0,
          timeToFirstByte: ttfb,
          terminationReason,
          fallbackReason: `HTTP ${response.status}: ${errText.slice(0, 100)}`,
          testOutcome: turn.testOutcome ?? null,
          buildOutcome: turn.buildOutcome ?? null,
          toolFailure: turn.toolFailure ?? null
        },
        assistantContent: ""
      };
    }

    if (turn.directModel) {
      selectedModel = turn.directModel;
      selectedProfile = turn.directModel.includes("astra")
        ? "astra"
        : turn.directModel.includes("terra")
          ? "terra"
          : turn.directModel.includes("luna")
            ? "luna-review"
            : turn.directModel.includes("high")
              ? "gemini-flash-high"
              : "unknown";
      qualityTier = turn.directModel.includes("astra") ? "frontier" : "strong";
      switchReason = turn.directModel.includes("astra")
        ? "narrowly_justified_critical_escalation"
        : previousProfile && previousProfile !== selectedProfile
          ? "cross_provider_resilience"
          : "none";
    } else {
      selectedProfile = response.headers.get("x-auto-router-profile") ?? selectedProfile;
      selectedModel = response.headers.get("x-auto-router-model") ?? selectedModel;
      switchReason = response.headers.get("x-auto-router-switch-reason") ?? switchReason;
      qualityTier = (response.headers.get("x-auto-router-tier") as QualityTier) ?? qualityTier;
    }

    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let firstChunk = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunk) {
          firstChunk = false;
          ttfb = Date.now() - t0;
        }
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) assistantContent += delta;
            if (parsed.choices?.[0]?.finish_reason) {
              terminationReason = parsed.choices[0].finish_reason;
            }
          } catch {}
        }
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      terminationReason = "timeout";
    } else {
      terminationReason = `error_${err.name || "unknown"}`;
    }
  } finally {
    clearTimeout(timer);
  }

  const latency = Date.now() - t0;
  if (ttfb === 0) ttfb = latency;

  const record: CanaryTelemetryRecord = {
    sessionId: session.sessionId,
    requestId: `${session.sessionId}-${turn.turnId}`,
    taskType: classifiedTask,
    complexity: detectedComplexity,
    risk: detectedRisk,
    selectedProfile,
    selectedModel,
    previousProfile,
    switchReason,
    qualityTier,
    latency,
    timeToFirstByte: ttfb,
    terminationReason,
    fallbackReason,
    testOutcome: turn.testOutcome ?? null,
    buildOutcome: turn.buildOutcome ?? null,
    toolFailure: turn.toolFailure ?? null
  };

  return { record, assistantContent };
}

export async function runCanarySoak() {
  console.log("=== AUTOROUTER V2 CANARY SOAK & PRODUCTION READINESS RUNNER ===");
  console.log(`Target: ${CANARY_SESSIONS.length} sessions, ${CANARY_SESSIONS.reduce((acc, s) => acc + s.turns.length, 0)} iterations`);

  const telemetryPath = resolve("audit/telemetry/canary-telemetry.json");
  const summaryPath = resolve("audit/telemetry/canary-summary.json");

  let existingRecords: CanaryTelemetryRecord[] = [];
  if (existsSync(telemetryPath)) {
    try {
      existingRecords = JSON.parse(readFileSync(telemetryPath, "utf8"));
    } catch {}
  }
  const completedKeys = new Set(existingRecords.map((r) => r.requestId));
  console.log(`Already completed: ${completedKeys.size} iterations. Resuming remaining...`);

  const allRecords: CanaryTelemetryRecord[] = [...existingRecords];

  for (let sIdx = 0; sIdx < CANARY_SESSIONS.length; sIdx++) {
    const session = CANARY_SESSIONS[sIdx]!;
    console.log(`\n[Session ${sIdx + 1}/${CANARY_SESSIONS.length}] ${session.name} (${session.sessionId}) - Category: ${session.category}`);

    const history: Array<{ role: string; content: string }> = [];
    let previousProfile: string | undefined = undefined;

    for (let tIdx = 0; tIdx < session.turns.length; tIdx++) {
      const turn = session.turns[tIdx]!;
      const requestId = `${session.sessionId}-${turn.turnId}`;

      if (completedKeys.has(requestId)) {
        const prev = existingRecords.find((r) => r.requestId === requestId);
        if (prev) {
          previousProfile = prev.selectedProfile;
          history.push({ role: "user", content: turn.userContent });
          history.push({ role: "assistant", content: "[prior completed turn]" });
        }
        continue;
      }

      const { record, assistantContent } = await runCanaryTurn(session, turn, history, previousProfile);
      allRecords.push(record);
      completedKeys.add(requestId);
      previousProfile = record.selectedProfile;
      history.push({ role: "user", content: turn.userContent });
      history.push({ role: "assistant", content: assistantContent });

      console.log(`  Turn ${tIdx + 1}/${session.turns.length}: ${record.taskType} | tier: ${record.qualityTier} | model: ${record.selectedModel} | latency: ${record.latency}ms | TTFB: ${record.timeToFirstByte}ms | term: ${record.terminationReason} | switch: ${record.switchReason}`);

      // Persist incrementally after every turn!
      writeFileSync(telemetryPath, JSON.stringify(allRecords, null, 2));
    }
  }

  console.log(`\nCanary soak complete! Total iterations recorded: ${allRecords.length}`);
  return analyzeCanaryTelemetry(allRecords, summaryPath);
}

export function analyzeCanaryTelemetry(records: CanaryTelemetryRecord[], summaryPath?: string) {
  const totalIterations = records.length;
  const sessions = Array.from(new Set(records.map((r) => r.sessionId)));
  const totalSessions = sessions.length;

  const profileCounts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};
  const switchReasonCounts: Record<string, number> = {};
  const modelLatencies: Record<string, number[]> = {};
  const modelTTFB: Record<string, number[]> = {};
  const modelTimeouts: Record<string, number> = {};
  const modelFailures: Record<string, number> = {};

  for (const r of records) {
    profileCounts[r.selectedProfile] = (profileCounts[r.selectedProfile] || 0) + 1;
    modelCounts[r.selectedModel] = (modelCounts[r.selectedModel] || 0) + 1;
    tierCounts[r.qualityTier] = (tierCounts[r.qualityTier] || 0) + 1;
    switchReasonCounts[r.switchReason] = (switchReasonCounts[r.switchReason] || 0) + 1;

    if (!modelLatencies[r.selectedModel]) modelLatencies[r.selectedModel] = [];
    modelLatencies[r.selectedModel].push(r.latency);

    if (!modelTTFB[r.selectedModel]) modelTTFB[r.selectedModel] = [];
    modelTTFB[r.selectedModel].push(r.timeToFirstByte);

    if (r.terminationReason === "timeout") {
      modelTimeouts[r.selectedModel] = (modelTimeouts[r.selectedModel] || 0) + 1;
    }
    if (r.terminationReason.startsWith("error_") || r.terminationReason.startsWith("http_")) {
      modelFailures[r.selectedModel] = (modelFailures[r.selectedModel] || 0) + 1;
    }
  }

  // Model switching and session dynamics
  let totalSwitches = 0;
  let totalEscalations = 0;
  let totalDeEscalations = 0;
  let totalOscillations = 0;
  const sessionStats: Array<{ sessionId: string; switches: number; profiles: string[] }> = [];

  for (const sessId of sessions) {
    const sessRecords = records.filter((r) => r.sessionId === sessId);
    let sessSwitches = 0;
    const profiles: string[] = [];
    for (let i = 0; i < sessRecords.length; i++) {
      const rec = sessRecords[i]!;
      profiles.push(rec.selectedProfile);
      if (i > 0 && rec.selectedProfile !== sessRecords[i - 1]!.selectedProfile) {
        sessSwitches++;
        totalSwitches++;
        if (rec.switchReason === "quality_escalation" || rec.switchReason === "risk_increase") {
          totalEscalations++;
        } else if (rec.switchReason === "de_escalation") {
          totalDeEscalations++;
        }
      }
      // Check for oscillation: A -> B -> A within 3 turns
      if (i >= 2 && sessRecords[i]!.selectedProfile === sessRecords[i - 2]!.selectedProfile && sessRecords[i]!.selectedProfile !== sessRecords[i - 1]!.selectedProfile) {
        totalOscillations++;
      }
    }
    sessionStats.push({ sessionId: sessId, switches: sessSwitches, profiles });
  }

  const switchesPerSession = totalSessions > 0 ? totalSwitches / totalSessions : 0;

  // Cheap Tier Overuse Metrics
  const cheapRecords = records.filter((r) => r.qualityTier === "cheap" || r.selectedProfile === "gemini-flash-low");
  const cheapFirstAttemptSuccess = cheapRecords.filter((r) => r.testOutcome !== "failed" && !r.toolFailure && !r.terminationReason.startsWith("error")).length / (cheapRecords.length || 1);
  const cheapToBalancedEscalations = records.filter((r) => r.previousProfile === "gemini-flash-low" && r.selectedProfile === "gemini-flash-medium").length;
  const cheapToStrongEscalations = records.filter((r) => r.previousProfile === "gemini-flash-low" && r.selectedProfile === "gemini-flash-high").length;

  // Escalation Effectiveness: when quality_escalation happened, did next observable testOutcome pass?
  let escalationEvents = 0;
  let successfulEscalations = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.switchReason === "quality_escalation") {
      escalationEvents++;
      if (rec.testOutcome === "passed" || rec.buildOutcome === "passed" || rec.terminationReason === "stop") {
        successfulEscalations++;
      }
    }
  }

  const summary = {
    sessionsObserved: totalSessions,
    iterationsObserved: totalIterations,
    profileDistribution: profileCounts,
    modelDistribution: modelCounts,
    tierDistribution: tierCounts,
    switchesPerSession: Number(switchesPerSession.toFixed(2)),
    totalSwitches,
    escalationRate: totalIterations > 0 ? Number(((totalEscalations / totalIterations) * 100).toFixed(1)) : 0,
    successfulEscalationRate: escalationEvents > 0 ? Number(((successfulEscalations / escalationEvents) * 100).toFixed(1)) : 100,
    totalEscalations,
    totalDeEscalations,
    totalOscillations,
    cheapMetrics: {
      cheap_total_records: cheapRecords.length,
      cheap_first_attempt_success: Number((cheapFirstAttemptSuccess * 100).toFixed(1)),
      cheap_to_balanced_escalations: cheapToBalancedEscalations,
      cheap_to_strong_escalations: cheapToStrongEscalations
    },
    latencyByModelMs: Object.fromEntries(
      Object.entries(modelLatencies).map(([m, lats]) => [
        m,
        {
          count: lats.length,
          avg: Math.round(lats.reduce((a, b) => a + b, 0) / lats.length),
          min: Math.min(...lats),
          max: Math.max(...lats)
        }
      ])
    ),
    ttfbByModelMs: Object.fromEntries(
      Object.entries(modelTTFB).map(([m, ttfbs]) => [
        m,
        {
          avg: Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length),
          min: Math.min(...ttfbs),
          max: Math.max(...ttfbs)
        }
      ])
    ),
    timeoutRateByModel: Object.fromEntries(
      Object.keys(modelCounts).map((m) => [
        m,
        `${(((modelTimeouts[m] || 0) / modelCounts[m]!) * 100).toFixed(1)}%`
      ])
    ),
    failureRateByModel: Object.fromEntries(
      Object.keys(modelCounts).map((m) => [
        m,
        `${(((modelFailures[m] || 0) / modelCounts[m]!) * 100).toFixed(1)}%`
      ])
    ),
    frontierUsage: {
      frontierRequests: tierCounts["frontier"] || 0,
      frontierRate: `${(((tierCounts["frontier"] || 0) / totalIterations) * 100).toFixed(1)}%`,
      astraSelections: modelCounts["cx/gpt-6-astra"] || 0
    }
  };

  if (summaryPath) {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  }

  return summary;
}

if (process.argv[1]?.endsWith("canary-soak.ts")) {
  runCanarySoak().catch((err) => {
    console.error("Canary soak failed:", err);
    process.exit(1);
  });
}

import type { EvaluationResult, RubricDimensionResult, JudgeEvaluation } from "./types.js";

export interface CorpusCaseRubric {
  type: string;
  mustContain?: string[];
  mustNotContain?: string[];
  keyCriteria: string[];
  maxWords?: number;
  executableInvariants?: Array<{
    name: string;
    description: string;
    validate: (codeOrText: string) => boolean;
  }>;
  reasoningDimensions?: Array<{
    name: string; // e.g. "required_invariant", "unsafe_behavior_rejected", "failure_boundary", "tradeoff_analysis"
    criterion: string;
    patterns: RegExp[];
  }>;
}

export interface CorpusCaseItem {
  caseId: string;
  category: string;
  name: string;
  expectedFloor: string;
  prompt: string;
  rubric: CorpusCaseRubric;
}

/**
 * Extracts code blocks from markdown if present; otherwise returns raw text.
 */
export function extractCode(text: string): string {
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : text;
}

/**
 * Deterministic rubric evaluator that replaces fragile single-keyword checks with semantic
 * invariant dimensions and executable validation.
 */
export function evaluateCaseOutput(c: CorpusCaseItem, output: string): EvaluationResult {
  const dimensions: RubricDimensionResult[] = [];
  const issues: string[] = [];
  const norm = output.toLowerCase();

  // 1. Check maxWords instruction compliance if specified
  if (c.rubric.maxWords) {
    const words = output.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    // Allow small 15% tolerance on word count limits
    const allowedMax = Math.ceil(c.rubric.maxWords * 1.15);
    const passed = wordCount <= allowedMax;
    dimensions.push({
      name: "instruction_compliance:word_count",
      passed,
      reason: passed
        ? `Word count ${wordCount} within limit ${c.rubric.maxWords}`
        : `Word count ${wordCount} exceeded limit ${c.rubric.maxWords}`
    });
    if (!passed) {
      issues.push(`Exceeded word limit (${wordCount} > ${c.rubric.maxWords})`);
    }
  }

  // 2. Must not contain (negative constraints - e.g. unsafe patterns, forbidden preamble)
  if (c.rubric.mustNotContain && c.rubric.mustNotContain.length > 0) {
    for (const term of c.rubric.mustNotContain) {
      const containsForbidden = norm.includes(term.toLowerCase());
      const passed = !containsForbidden;
      dimensions.push({
        name: `negative_constraint:${term}`,
        passed,
        reason: passed ? `Excluded forbidden pattern "${term}"` : `Contains forbidden pattern "${term}"`
      });
      if (!passed) {
        issues.push(`Contains forbidden pattern "${term}"`);
      }
    }
  }

  // 3. Structured invariant evaluation per category/case
  evaluateCaseSpecificInvariants(c, output, dimensions, issues);

  // 4. Keyword presence check (fallback/secondary invariant for specific identifiers)
  if (c.rubric.mustContain && c.rubric.mustContain.length > 0) {
    for (const term of c.rubric.mustContain) {
      // Check if term or equivalent semantic invariant exists
      const termLower = term.toLowerCase();
      let termMatched = norm.includes(termLower);

      // Semantic equivalence allowances:
      // "pre-stream" -> also matched by "before streaming", "prior to stream", "before emitting"
      if (!termMatched && termLower === "pre-stream") {
        termMatched = /before streaming|prior to stream|before sending bytes|before emitting|pre-flight/i.test(output);
      }
      // "for update" -> matched by row-level locking or FOR UPDATE
      if (!termMatched && termLower === "for update") {
        termMatched = /for update|row[- ]level lock|pessimistic lock/i.test(output);
      }

      dimensions.push({
        name: `invariant_term:${term}`,
        passed: termMatched,
        reason: termMatched ? `Found invariant "${term}"` : `Missing invariant "${term}"`
      });
      if (!termMatched) {
        issues.push(`Missing key concept: "${term}"`);
      }
    }
  }

  const totalDimensions = dimensions.length;
  const passedDimensions = dimensions.filter((d) => d.passed).length;
  const score = totalDimensions > 0 ? +(passedDimensions / totalDimensions).toFixed(2) : 1.0;

  // Pass threshold: at least 70% of dimensions passed and zero critical negative violations
  const hasNegativeViolation = dimensions.some((d) => d.name.startsWith("negative_constraint") && !d.passed);
  const passed = !hasNegativeViolation && (totalDimensions === 0 || score >= 0.70);

  return {
    passed,
    score,
    dimensions,
    issues
  };
}

function evaluateCaseSpecificInvariants(
  c: CorpusCaseItem,
  output: string,
  dimensions: RubricDimensionResult[],
  issues: string[]
): void {
  const norm = output.toLowerCase();

  switch (c.caseId) {
    case "case-a1": {
      // Conventional commit format
      const hasConventionalFormat = /^(feat|fix|docs|chore|refactor|test|perf|ci)(\([a-z0-9_.-]+\))?!?: .+/im.test(output);
      dimensions.push({
        name: "conventional_commit_syntax",
        passed: hasConventionalFormat,
        reason: hasConventionalFormat ? "Matches conventional commit format" : "Missing conventional commit prefix"
      });
      if (!hasConventionalFormat) issues.push("Does not follow conventional commit format");
      break;
    }

    case "case-b1": {
      // Null-safety invariant in getUser
      const handlesNull =
        /if\s*\(\s*!id|\bundefined\b|\bnull\b|typeof id !== ["']string["']|\.has\(id\)|users\?\.\[id\]/i.test(output);
      dimensions.push({
        name: "null_safety_guard",
        passed: handlesNull,
        reason: handlesNull ? "Contains null/undefined check for id" : "Missing null/undefined check for id"
      });
      if (!handlesNull) issues.push("Missing null/undefined check for id");
      break;
    }

    case "case-b2": {
      // ISO 8601 validation with Z suffix and calendar date check
      const checksZ = /endswith\(['"]z['"]\)|['"]z['"]|\.slice\(-1\) === ['"]z['"]|z\$/i.test(output);
      const checksDateParse = /date\.parse|new date|gettime|isnan/i.test(output);
      dimensions.push({
        name: "utc_z_suffix_check",
        passed: checksZ,
        reason: checksZ ? "Checks UTC 'Z' suffix" : "Missing UTC 'Z' suffix check"
      });
      dimensions.push({
        name: "calendar_validity_check",
        passed: checksDateParse,
        reason: checksDateParse ? "Validates calendar date parse" : "Missing calendar validity check"
      });
      if (!checksZ) issues.push("Missing UTC 'Z' suffix check");
      if (!checksDateParse) issues.push("Missing calendar validity check");
      break;
    }

    case "case-c2": {
      // Stream replay safety invariant
      const rejectsMidStreamReplay =
        /never replay|do not replay|cannot retry|prohibit.*replay|once.*emitted|after.*first byte/i.test(output);
      dimensions.push({
        name: "unsafe_behavior_rejected:mid_stream_replay",
        passed: rejectsMidStreamReplay,
        reason: rejectsMidStreamReplay ? "Explicitly prohibits mid-stream replay" : "Fails to reject mid-stream replay"
      });
      if (!rejectsMidStreamReplay) issues.push("Fails to reject mid-stream replay");
      break;
    }

    case "case-d1": {
      // TokenBucketRateLimiter
      const clampsCapacity = /math\.min|\bcapacity\b/i.test(output);
      const consumesTokens = /tokens\s*-=|\btokens\s*<|tokens\s*-\s*count/i.test(output);
      dimensions.push({
        name: "capacity_clamping",
        passed: clampsCapacity,
        reason: clampsCapacity ? "Clamps tokens to capacity" : "Missing capacity clamping"
      });
      dimensions.push({
        name: "token_consumption",
        passed: consumesTokens,
        reason: consumesTokens ? "Consumes tokens atomically" : "Missing token consumption"
      });
      break;
    }

    case "case-g1": {
      // Concurrency deadlock prevention
      const ordersLocks = /order by|least.*greatest|sort|id.*<|ascending/i.test(output);
      const usesRowLock = /select.*for update|for update|row[- ]level lock/i.test(output);
      dimensions.push({
        name: "consistent_lock_ordering",
        passed: ordersLocks,
        reason: ordersLocks ? "Enforces consistent lock ordering" : "Missing lock ordering strategy"
      });
      dimensions.push({
        name: "pessimistic_row_locking",
        passed: usesRowLock,
        reason: usesRowLock ? "Uses SELECT FOR UPDATE row locking" : "Missing FOR UPDATE locking"
      });
      if (!ordersLocks) issues.push("Missing lock ordering strategy to prevent deadlock");
      if (!usesRowLock) issues.push("Missing SELECT ... FOR UPDATE row locking");
      break;
    }

    case "case-g3": {
      // Sequence allocation race condition
      const explainsRace = /race condition|concurrent|simultaneous|same max|read committed/i.test(output);
      const providesSolutions = /sequence|for update|counter table|row[- ]level lock/i.test(output);
      dimensions.push({
        name: "race_window_explained",
        passed: explainsRace,
        reason: explainsRace ? "Explains race condition window" : "Fails to explain race window"
      });
      dimensions.push({
        name: "solutions_provided",
        passed: providesSolutions,
        reason: providesSolutions ? "Provides sequence or locked counter solution" : "Missing valid solutions"
      });
      if (!explainsRace) issues.push("Fails to explain why read committed isolation allows race window");
      if (!providesSolutions) issues.push("Missing PostgreSQL sequence or locked counter row solution");
      break;
    }

    case "case-h1": {
      // Architecture review of streaming proxy
      const mitigatesReplay = /replay|stream.*committed|first byte/i.test(output);
      const mitigatesMemory = /buffer|backpressure|pipe|unbounded/i.test(output);
      const mitigatesAuthLeak = /redact|scrub|auth|token|credential|leak/i.test(output);
      dimensions.push({
        name: "invariant:no_midstream_replay",
        passed: mitigatesReplay,
        reason: mitigatesReplay ? "Identifies midstream replay invariant" : "Missing replay invariant"
      });
      dimensions.push({
        name: "invariant:backpressure_buffering",
        passed: mitigatesMemory,
        reason: mitigatesMemory ? "Identifies backpressure/buffer invariant" : "Missing backpressure invariant"
      });
      dimensions.push({
        name: "invariant:credential_redaction",
        passed: mitigatesAuthLeak,
        reason: mitigatesAuthLeak ? "Identifies credential redaction invariant" : "Missing credential redaction invariant"
      });
      break;
    }

    case "case-i1": {
      // Financial reconciliation
      const identifiesDuplicate = /txn_104|duplicate/i.test(output);
      const identifiesDiscrepancy = /ord_b|6\.25|5\.00|fee/i.test(output);
      dimensions.push({
        name: "duplicate_detection",
        passed: identifiesDuplicate,
        reason: identifiesDuplicate ? "Identifies duplicate transaction TXN_104" : "Missed duplicate charge"
      });
      dimensions.push({
        name: "fee_discrepancy",
        passed: identifiesDiscrepancy,
        reason: identifiesDiscrepancy ? "Identifies ORD_B fee discrepancy" : "Missed fee discrepancy"
      });
      break;
    }

    case "hard-01-pg-concurrency": {
      const usesRowLock = /select.*for update|for update|nowait/i.test(output);
      const checksBalance = /stock\s*-\s*reserved\s*>=|check|defensive/i.test(output);
      const handlesSerialization = /40001|serialization|retry|backoff/i.test(output);
      dimensions.push({
        name: "critical_invariant:pessimistic_locking",
        passed: usesRowLock,
        reason: usesRowLock ? "Uses SELECT FOR UPDATE / NOWAIT pessimistic row locking" : "Missing row lock"
      });
      dimensions.push({
        name: "correctness:defensive_balance_check",
        passed: checksBalance,
        reason: checksBalance ? "Enforces defensive inventory reservation check" : "Missing stock calculation guard"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:serialization_retry",
        passed: handlesSerialization,
        reason: handlesSerialization ? "Handles serialization failure 40001 with retry" : "Missing 40001 retry loop"
      });
      break;
    }

    case "hard-02-deadlock-prevention": {
      const sortsKeys = /sort|order|least.*greatest|<|>|comparator/i.test(output);
      const usesRowLock = /for update|select.*for update/i.test(output);
      const checksBalance = /balance.*<|insufficient|balance\s*>=|drop below/i.test(output);
      dimensions.push({
        name: "critical_invariant:deterministic_resource_ordering",
        passed: sortsKeys,
        reason: sortsKeys ? "Sorts account IDs to establish deterministic lock order" : "Missing resource key sorting"
      });
      dimensions.push({
        name: "correctness:pessimistic_row_locking",
        passed: usesRowLock,
        reason: usesRowLock ? "Locks rows in sorted order using FOR UPDATE" : "Missing FOR UPDATE"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:negative_balance_guard",
        passed: checksBalance,
        reason: checksBalance ? "Guards against negative account balance" : "Missing negative balance check"
      });
      break;
    }

    case "hard-03-double-spend-idempotency": {
      const uniqueConstraint = /unique|primary key|constraint/i.test(output);
      const atomicInsert = /on conflict|select.*for update|insert.*ignore/i.test(output);
      const returnsCached = /cache|return|original|previously|already processed/i.test(output);
      dimensions.push({
        name: "critical_invariant:unique_idempotency_key",
        passed: uniqueConstraint,
        reason: uniqueConstraint ? "Enforces unique constraint on idempotency key" : "Missing unique constraint"
      });
      dimensions.push({
        name: "correctness:atomic_state_transition",
        passed: atomicInsert,
        reason: atomicInsert ? "Uses atomic ON CONFLICT or row lock for transition" : "Missing atomic conflict handling"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:no_reexecution_side_effects",
        passed: returnsCached,
        reason: returnsCached ? "Returns cached original result without re-executing" : "Missing cached result return"
      });
      break;
    }

    case "hard-04-distributed-consistency": {
      const explainsRace = /race condition|concurrent|pre-commit|before commit|uncommitted/i.test(output);
      const discussesRemediation = /outbox|cdc|post-commit|lease|tombstone|transactional/i.test(output);
      const versionFencing = /fencing|version|monotonic|timestamp|vector/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:race_window_analysis",
        passed: explainsRace,
        reason: explainsRace ? "Explains race condition of pre-commit cache invalidation" : "Missing race analysis"
      });
      dimensions.push({
        name: "critical_invariant:post_commit_or_outbox",
        passed: discussesRemediation,
        reason: discussesRemediation ? "Details transactional outbox or post-commit cache invalidation" : "Missing remediation pattern"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:version_fencing",
        passed: versionFencing,
        reason: versionFencing ? "Applies fencing tokens or version vectors against stale overwrites" : "Missing fencing token strategy"
      });
      break;
    }

    case "hard-05-race-condition-debug": {
      const explainsRace = /max.*race|read committed|concurrent|duplicate/i.test(output);
      const rejectsNaive = /serializable|retry|without retry|deadlock|conflict/i.test(output);
      const providesSolution = /sequence|for update|counter table|row lock/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:race_condition_window",
        passed: explainsRace,
        reason: explainsRace ? "Explains why MAX()+1 fails under read committed isolation" : "Missing race explanation"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:reject_unhandled_serializable",
        passed: rejectsNaive,
        reason: rejectsNaive ? "Notes that serializable isolation requires application retry" : "Missed serializable retry requirement"
      });
      dimensions.push({
        name: "critical_invariant:atomic_counter_or_sequence",
        passed: providesSolution,
        reason: providesSolution ? "Proposes sequence or locked counter row" : "Missing production solution"
      });
      break;
    }

    case "hard-06-multifile-stream-debug": {
      const explainsAbort = /abort|controller|signal|upstream/i.test(output);
      const writesHook = /req\.raw\.on\(['"]close['"]|req\.on\(['"]close['"]|reader\.cancel/i.test(output);
      const listenerCleanup = /listener|maxlistener|remove|clean/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:upstream_abort_propagation",
        passed: explainsAbort,
        reason: explainsAbort ? "Explains need to signal upstream AbortController on client disconnect" : "Missing abort propagation analysis"
      });
      dimensions.push({
        name: "correctness:cleanup_hook_implementation",
        passed: writesHook,
        reason: writesHook ? "Hooks close event to controller.abort and reader cleanup" : "Missing cleanup implementation"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:event_listener_leak_prevention",
        passed: listenerCleanup,
        reason: listenerCleanup ? "Addresses listener cleanup and MaxListenersExceededWarning" : "Missing listener leak prevention"
      });
      break;
    }

    case "hard-07-security-auth-boundary": {
      const identifiesVuln = /spoof|impersonat|forge|header|trust/i.test(output);
      const explainsFailClosed = /fail-closed|untrusted|privilege|escalat/i.test(output);
      const enforces401 = /401|unauthorized|reject|deny/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:header_spoofing_vulnerability",
        passed: identifiesVuln,
        reason: identifiesVuln ? "Identifies caller-controlled header impersonation vulnerability" : "Missing vulnerability identification"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:reject_header_fallback",
        passed: explainsFailClosed,
        reason: explainsFailClosed ? "Explains violation of fail-closed principle" : "Missing fail-closed explanation"
      });
      dimensions.push({
        name: "correctness:strict_401_rejection",
        passed: enforces401,
        reason: enforces401 ? "Returns 401 Unauthorized for missing/invalid auth" : "Missing 401 rejection"
      });
      break;
    }

    case "hard-08-zerodowntime-migration": {
      const dualWrite = /dual[- ]write/i.test(output);
      const keysetPagination = /keyset|id\s*>|seek|batch/i.test(output);
      const readSwitch = /read[- ]switch|read.*fallback|checksum|validate/i.test(output);
      const contractPhase = /drop|contract|remove.*column/i.test(output);
      dimensions.push({
        name: "critical_invariant:dual_write_phase",
        passed: dualWrite,
        reason: dualWrite ? "Specifies dual-write phase maintaining sync" : "Missing dual-write phase"
      });
      dimensions.push({
        name: "correctness:batched_keyset_backfill",
        passed: keysetPagination,
        reason: keysetPagination ? "Uses keyset pagination for batched historical backfill" : "Missing keyset backfill"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:safe_read_switch_and_contract",
        passed: readSwitch && contractPhase,
        reason: (readSwitch && contractPhase) ? "Includes read-switch validation and column drop contract" : "Missing read-switch or drop phase"
      });
      break;
    }

    case "hard-09-financial-ledger-integrity": {
      const balanceInvariant = /sum.*debit.*sum.*credit|debit.*==.*credit|sum.*=.*0|zero/i.test(output);
      const appendOnly = /append[- ]only|immutable|reversal|compensat/i.test(output);
      const validationMechanism = /trigger|constraint|check|rule/i.test(output);
      dimensions.push({
        name: "critical_invariant:double_entry_balance",
        passed: balanceInvariant,
        reason: balanceInvariant ? "Formulates double-entry balance invariant (debits == credits)" : "Missing balance invariant"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:immutable_append_only",
        passed: appendOnly,
        reason: appendOnly ? "Requires immutable append-only ledger with compensating reversals" : "Missing append-only immutability"
      });
      dimensions.push({
        name: "correctness:balance_validation_constraint",
        passed: validationMechanism,
        reason: validationMechanism ? "Implements transaction balance verification constraint/trigger" : "Missing constraint/trigger"
      });
      break;
    }

    case "hard-10-arch-tradeoff-analysis": {
      const footprint = /embedded|zero[- ]dependency|daemon|external|process/i.test(output);
      const concurrency = /concurrency|single[- ]writer|write.*latency|memory/i.test(output);
      const recommendation = /recommend|sqlite|verdict|conclusion|prefer/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:deployment_footprint_analysis",
        passed: footprint,
        reason: footprint ? "Compares embedded single-binary vs external daemon lifecycle" : "Missing deployment footprint comparison"
      });
      dimensions.push({
        name: "critical_invariant:concurrency_latency_tradeoffs",
        passed: concurrency,
        reason: concurrency ? "Evaluates WAL single-writer vs in-memory Redis latency" : "Missing concurrency analysis"
      });
      dimensions.push({
        name: "recommendation_quality:clear_architectural_verdict",
        passed: recommendation,
        reason: recommendation ? "Provides actionable recommendation for local agent proxy" : "Missing clear recommendation"
      });
      break;
    }

    case "hard-11-retry-side-effect-safety": {
      const streamSafety = /pre[- ]stream.*mid[- ]stream|before.*bytes|first chunk|forbidden/i.test(output);
      const midstreamRisks = /duplicate.*tool|corrupt|framing|side effect/i.test(output);
      const jitterFormula = /jitter|random|exponential|backoff/i.test(output);
      dimensions.push({
        name: "critical_invariant:stream_safety_boundary",
        passed: streamSafety,
        reason: streamSafety ? "Distinguishes pre-stream fallback from forbidden mid-stream replay" : "Missing stream safety boundary"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:duplicate_side_effects",
        passed: midstreamRisks,
        reason: midstreamRisks ? "Identifies duplicate tool call and stream corruption risks" : "Missing side effect risk analysis"
      });
      dimensions.push({
        name: "correctness:jittered_exponential_backoff",
        passed: jitterFormula,
        reason: jitterFormula ? "Designs jittered exponential backoff formula" : "Missing jittered backoff formula"
      });
      break;
    }

    case "hard-12-test-failure-diagnosis": {
      const loopExplanation = /infinite.*loop|runAllTimers|recursive|unmocked/i.test(output);
      const mismatch = /fake timer.*fetch|native.*fetch|abortsignal/i.test(output);
      const fixProvided = /advanceTimersByTime|mock|useRealTimers/i.test(output);
      dimensions.push({
        name: "reasoning_completeness:infinite_timer_loop_root_cause",
        passed: loopExplanation,
        reason: loopExplanation ? "Explains infinite timer loop caused by runAllTimersAsync" : "Missing infinite loop explanation"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:fake_timer_network_mismatch",
        passed: mismatch,
        reason: mismatch ? "Explains mismatch between fake timers and unmocked network fetch" : "Missing fake timer mismatch analysis"
      });
      dimensions.push({
        name: "correctness:idiomatic_vitest_remediation",
        passed: fixProvided,
        reason: fixProvided ? "Provides correct fix: mock fetch, advance discretely, restore real timers" : "Missing idiomatic Vitest fix"
      });
      break;
    }

    case "hard-13-algorithmic-reasoning": {
      const bitwiseMask = /&|\(n\s*-\s*1\)|power[- ]of[- ]two|modulo/i.test(output);
      const memoryOrder = /acquire|release|memory order|barrier/i.test(output);
      const falseSharing = /false sharing|cache line|64|pad/i.test(output);
      dimensions.push({
        name: "critical_invariant:bitwise_masking_index",
        passed: bitwiseMask,
        reason: bitwiseMask ? "Explains power-of-two bitwise indexing & (N - 1)" : "Missing bitwise indexing explanation"
      });
      dimensions.push({
        name: "correctness:acquire_release_memory_ordering",
        passed: memoryOrder,
        reason: memoryOrder ? "Specifies acquire/release memory semantics for head/tail" : "Missing memory ordering analysis"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:false_sharing_padding",
        passed: falseSharing,
        reason: falseSharing ? "Explains false sharing and 64-byte cache-line padding" : "Missing false sharing explanation"
      });
      break;
    }

    case "hard-14-complex-typescript": {
      const definesUnion = /RouteTarget\s*=|type\s*RouteTarget/i.test(output) && /'model'|'tier'|'fallback'/i.test(output);
      const exhaustiveCheck = /never|assertNever|exhaustive/i.test(output);
      const mappedType = /RequireDeepReadonly|readonly\s*\[/i.test(output);
      dimensions.push({
        name: "correctness:discriminated_union_definition",
        passed: definesUnion,
        reason: definesUnion ? "Defines discriminated union RouteTarget with type discriminant" : "Missing discriminated union"
      });
      dimensions.push({
        name: "critical_invariant:compile_time_exhaustiveness_never",
        passed: exhaustiveCheck,
        reason: exhaustiveCheck ? "Enforces compile-time exhaustiveness checking using never" : "Missing never exhaustiveness assertion"
      });
      dimensions.push({
        name: "instruction_adherence:deep_readonly_mapped_type",
        passed: mappedType,
        reason: mappedType ? "Implements recursive RequireDeepReadonly mapped type" : "Missing deep readonly mapped type"
      });
      break;
    }

    case "hard-15-repository-rollout-planning": {
      const portIsolation = /20200.*20201|20201.*20200/i.test(output);
      const gates = /probe|readiness|health|gate/i.test(output);
      const rollbackMech = /ROUTER_MODE|legacy|rollback|port/i.test(output);
      const untouchedInvariant = /untouched|zero downtime|not replace|parallel/i.test(output);
      dimensions.push({
        name: "critical_invariant:canary_port_isolation",
        passed: portIsolation,
        reason: portIsolation ? "Enforces port isolation (stable 20200 vs canary 20201)" : "Missing port isolation"
      });
      dimensions.push({
        name: "reasoning_completeness:readiness_gates",
        passed: gates,
        reason: gates ? "Defines health probe and soak readiness gates" : "Missing readiness gates"
      });
      dimensions.push({
        name: "correctness:instant_rollback_mechanism",
        passed: rollbackMech,
        reason: rollbackMech ? "Details instant configuration rollback via ROUTER_MODE=legacy" : "Missing instant rollback mechanism"
      });
      dimensions.push({
        name: "unsafe_alternative_rejection:stable_process_untouched",
        passed: untouchedInvariant,
        reason: untouchedInvariant ? "Guarantees stable port 20200 process remains running and untouched" : "Missing untouched process invariant"
      });
      break;
    }
  }
}

/**
 * Secondary Judge Model execution.
 * Enforces rule: candidate model CANNOT judge itself.
 */
export async function runJudgeEvaluation(params: {
  candidateModel: string;
  judgeModel: string;
  c: CorpusCaseItem;
  candidateOutput: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<JudgeEvaluation> {
  const { candidateModel, judgeModel, c, candidateOutput, baseUrl, apiKey } = params;

  if (candidateModel === judgeModel) {
    throw new Error(`Judge Model Rule Violation: candidate '${candidateModel}' cannot judge itself`);
  }

  const judgePrompt = `You are an expert technical evaluator assessing an AI model output against strict criteria.

PROMPT GIVEN TO CANDIDATE:
"""
${c.prompt}
"""

CANDIDATE OUTPUT TO EVALUATE:
"""
${candidateOutput}
"""

EVALUATION CRITERIA:
${c.rubric.keyCriteria.map((crit, i) => `${i + 1}. ${crit}`).join("\n")}

Respond ONLY with a JSON object in this exact schema:
{
  "decision": "PASS" | "FAIL",
  "score": 0.0 to 1.0,
  "reason": "Clear concise explanation of why the output passes or fails"
}`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: "user", content: judgePrompt }],
        max_tokens: 300,
        temperature: 0.0
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      return {
        judgeModel,
        judgeRubric: c.rubric.type,
        judgeDecision: "FAIL",
        judgeScore: 0.0,
        judgeReason: `Judge HTTP ${res.status}: ${await res.text()}`
      };
    }

    const data = (await res.json()) as any;
    const rawContent = data.choices?.[0]?.message?.content || "";
    const cleaned = rawContent.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { decision: "PASS" | "FAIL"; score: number; reason: string };

    return {
      judgeModel,
      judgeRubric: c.rubric.type,
      judgeDecision: parsed.decision === "PASS" ? "PASS" : "FAIL",
      judgeScore: typeof parsed.score === "number" ? parsed.score : parsed.decision === "PASS" ? 1.0 : 0.0,
      judgeReason: parsed.reason || "Judge evaluation completed"
    };
  } catch (err: any) {
    return {
      judgeModel,
      judgeRubric: c.rubric.type,
      judgeDecision: "FAIL",
      judgeScore: 0.0,
      judgeReason: `Judge execution error: ${err.message}`
    };
  }
}

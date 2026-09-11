AutoRouter is a lightweight local intelligent routing layer for AI agents.

Architecture:

Hermes / Codex / compatible client
        ↓
AutoRouter :20200
        ↓
9Router :20128
        ↓
virtual model combos:
- ar-code
- ar-analysis
- ar-research
- ar-fast
        ↓
actual AI provider/model

Primary responsibility:
AutoRouter decides WHAT type of workload a request represents.

9Router decides WHICH concrete model/provider should execute it.

Routing categories:

- smart-code
  Coding, debugging, repository work, Git, APIs, SQL, tests, refactoring and software engineering.

- smart-analysis
  Documents, accounting, financial analysis, spreadsheets, contracts, audit and structured analysis.

- web-research
  Current information, web research, news, releases, prices and time-sensitive information.

- smart-main
  Complex reasoning, planning, architecture, strategy and difficult comparisons.

- fast-chat
  Simple explanations, translation, rewriting, summaries and casual requests.

Key design goals:

1. Reliable long-running streaming for autonomous coding agents.
2. Correct timeout behavior:
   - connection/header timeout
   - first-byte timeout
   - stream-idle timeout
   - avoid killing healthy long-running streams solely because total runtime exceeds a fixed limit.
3. Safe failure behavior:
   - distinguish pre-stream failures from mid-stream failures
   - never blindly replay partially emitted streams
   - prevent duplicate tool calls or side effects.
4. Clear fallback ownership:
   - AutoRouter chooses workload route
   - 9Router owns concrete model/provider fallback.
5. Latest user intent should have stronger routing weight than old conversation history.
6. Preserve tool and vision capability requirements.
7. Strong structured observability for routing, upstream errors, timeouts and stream lifecycle.
8. Configuration validation at startup.
9. Lightweight local architecture with minimal dependencies and very low routing overhead.
10. Maintain backward compatibility wherever practical.

Current optimization focus:

- investigate intermittent stream stall / HTTP 502 failures
- harden long-running streaming
- improve timeout architecture
- audit fallback semantics
- improve routing accuracy
- improve capability handling
- add deterministic regression tests
- improve observability
- simplify misleading or redundant configuration

Development principles:

- inspect before modifying
- reproduce bugs before fixing
- use regression tests
- prefer the smallest correct change
- avoid unnecessary frameworks or infrastructure
- do not expose credentials or secrets
- do not modify external 9Router code unless explicitly requested
- do not duplicate responsibilities already handled by 9Router

The project should remain a focused local routing layer, not become a full AI gateway platform.

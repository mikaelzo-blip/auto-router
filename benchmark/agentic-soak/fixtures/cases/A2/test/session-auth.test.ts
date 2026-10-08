import test from "node:test";
import assert from "node:assert";
import { SessionService } from "../src/session-service.js";
import { TokenValidator } from "../src/token-validator.js";

test("SessionAuth - valid active session token validates successfully", () => {
  const service = new SessionService();
  const validator = new TokenValidator(service);

  const session = service.createSession("user_123", "tenant_abc");
  const token = validator.generateToken({
    sessionId: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    exp: Date.now() + 60000
  });

  const res = validator.validateToken(token);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.payload?.userId, "user_123");
});

test("SessionAuth - revoked session token must be rejected as invalid", () => {
  const service = new SessionService();
  const validator = new TokenValidator(service);

  const session = service.createSession("user_456", "tenant_xyz");
  const token = validator.generateToken({
    sessionId: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    exp: Date.now() + 60000
  });

  // Explicitly revoke the session
  service.revokeSession(session.id);

  // The validator MUST reject tokens belonging to revoked sessions!
  const res = validator.validateToken(token);
  assert.strictEqual(res.valid, false, "Token from revoked session must not validate");
  assert.strictEqual(res.error, "SESSION_REVOKED");
});

import test from "node:test";
import assert from "node:assert";
import { SessionService } from "../src/session-service.js";
import { TokenValidator } from "../src/token-validator.js";

test("Hidden: SessionAuth - refreshed session invalidates predecessor session", () => {
  const service = new SessionService();
  const validator = new TokenValidator(service);

  const oldSession = service.createSession("user_refresh", "tenant_refresh");
  const oldToken = validator.generateToken({
    sessionId: oldSession.id,
    userId: oldSession.userId,
    tenantId: oldSession.tenantId,
    exp: Date.now() + 60000
  });

  // Refresh creates new session and MUST revoke the old one
  const newSession = service.refreshSession(oldSession.id);
  assert.ok(newSession, "New session should be created");
  assert.notStrictEqual(newSession.id, oldSession.id);

  // Old token must now be rejected
  const oldVal = validator.validateToken(oldToken);
  assert.strictEqual(oldVal.valid, false, "Predecessor session token must be invalid after refresh");
  assert.strictEqual(oldVal.error, "SESSION_REVOKED");

  // New session token must be valid
  const newToken = validator.generateToken({
    sessionId: newSession.id,
    userId: newSession.userId,
    tenantId: newSession.tenantId,
    exp: Date.now() + 60000
  });
  const newVal = validator.validateToken(newToken);
  assert.strictEqual(newVal.valid, true);
});

test("Hidden: SessionAuth - non-existent session ID rejected as revoked", () => {
  const service = new SessionService();
  const validator = new TokenValidator(service);

  const fakeToken = validator.generateToken({
    sessionId: "sess_non_existent",
    userId: "user_fake",
    tenantId: "tenant_fake",
    exp: Date.now() + 60000
  });

  const res = validator.validateToken(fakeToken);
  assert.strictEqual(res.valid, false);
});

import { SessionService } from "./session-service.js";

export interface TokenPayload {
  sessionId: string;
  userId: string;
  tenantId: string;
  exp: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  payload?: TokenPayload;
}

export class TokenValidator {
  private readonly sessionService: SessionService;

  constructor(sessionService: SessionService) {
    this.sessionService = sessionService;
  }

  public generateToken(payload: TokenPayload): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  public validateToken(token: string): ValidationResult {
    try {
      const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf-8")) as TokenPayload;

      if (!decoded.sessionId || !decoded.userId || !decoded.tenantId) {
        return { valid: false, error: "MALFORMED_TOKEN" };
      }

      if (Date.now() > decoded.exp) {
        return { valid: false, error: "TOKEN_EXPIRED" };
      }

      // Defect: Fails to check sessionService.isSessionRevoked(decoded.sessionId)
      return { valid: true, payload: decoded };
    } catch {
      return { valid: false, error: "INVALID_FORMAT" };
    }
  }
}

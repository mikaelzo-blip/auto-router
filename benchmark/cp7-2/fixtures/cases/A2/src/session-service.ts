export interface Session {
  id: string;
  userId: string;
  tenantId: string;
  revoked: boolean;
  createdAt: number;
}

export class SessionService {
  private readonly sessions: Map<string, Session> = new Map();

  public createSession(userId: string, tenantId: string): Session {
    const session: Session = {
      id: `sess_${Math.random().toString(36).slice(2)}`,
      userId,
      tenantId,
      revoked: false,
      createdAt: Date.now()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  public getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  public isSessionRevoked(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return true;
    return session.revoked;
  }

  public revokeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.revoked = true;
    return true;
  }

  public refreshSession(oldSessionId: string): Session | null {
    const oldSession = this.sessions.get(oldSessionId);
    if (!oldSession || oldSession.revoked) {
      return null;
    }
    // Defect: Fails to revoke old session on refresh
    return this.createSession(oldSession.userId, oldSession.tenantId);
  }
}

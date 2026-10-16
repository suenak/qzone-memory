/** QQ authentication failures only; network failures and licence errors are unrelated. */
export function requiresQqLogin(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /QQ_LOGIN_REQUIRED:|(?:^|[^\d-])-3000(?!\d)|^(?:请先登录|尚未登录 QQ 空间|登录会话缺少有效的 p_skey)\s*$/.test(message);
}

export class QqSessionState {
  private revision = 0;
  expired = false;
  private listeners = new Set<() => void>();

  onExpired(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A new login attempt makes outstanding requests from the old session obsolete. */
  beginLogin() { this.revision += 1; }
  authenticated() { this.revision += 1; this.expired = false; }
  loggedOut() { this.revision += 1; this.expired = false; }

  expire() {
    if (this.expired) return;
    this.expired = true;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  async request<T>(request: () => Promise<T>, inspectProgress = false): Promise<T> {
    const revision = this.revision;
    try {
      const result = await request();
      // Recovery commands can resolve with an error progress snapshot rather than reject.
      if (inspectProgress && revision === this.revision && result && typeof result === "object"
        && "message" in result && requiresQqLogin(result.message)) this.expire();
      return result;
    } catch (error) {
      if (revision === this.revision && requiresQqLogin(error)) this.expire();
      throw error;
    }
  }
}

export const qqSession = new QqSessionState();

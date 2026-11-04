package com.drivemate.api;

/** Close transient authenticated connections after their database session is revoked. */
public interface SessionDisconnect {
    void disconnectSession(String tokenHash);
    void disconnectAccountSessions(String userId);
}

package com.drivemate.api;

/** Disconnect external credentials before removing a local account. */
public interface AccountDisconnect {
    void disconnectAccount(String userId);
}

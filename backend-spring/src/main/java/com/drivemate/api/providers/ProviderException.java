package com.drivemate.api.providers;

/** Safe public exception: provider response bodies and credentials are never retained. */
public class ProviderException extends RuntimeException {
    private final String code;
    private final int status;
    private final boolean retryable;
    private final Integer upstreamStatus;
    private final Double retryAfter;
    public ProviderException(String code, String message, int status) { this(code, message, status, false, null, null); }
    public ProviderException(String code, String message, int status, boolean retryable, Integer upstreamStatus, Double retryAfter) {
        super(message); this.code = code; this.status = status; this.retryable = retryable;
        this.upstreamStatus = upstreamStatus; this.retryAfter = retryAfter;
    }
    public String code() { return code; }
    public int status() { return status; }
    public boolean retryable() { return retryable; }
    public Integer upstreamStatus() { return upstreamStatus; }
    public Double retryAfter() { return retryAfter; }
}

package com.drivemate.api;

public class ApiException extends RuntimeException {
    private final String code;
    private final int status;

    public ApiException(String code, String message, int status) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public String code() { return code; }
    public int status() { return status; }

    public static ApiException invalid() {
        return new ApiException("invalid_request", "입력 형식과 범위를 확인해 주세요.", 422);
    }
}

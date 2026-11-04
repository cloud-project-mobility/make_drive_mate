package com.drivemate.api;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ApiErrors {
    private static final Logger LOG = LoggerFactory.getLogger(ApiErrors.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<?> api(ApiException exception) {
        ResponseEntity.BodyBuilder response = ResponseEntity.status(exception.status());
        if (exception.status() == 401) response.header("WWW-Authenticate", "Bearer");
        if (exception.status() == 429) response.header("Retry-After", "60");
        return response.body(Map.of("error", Map.of("code", exception.code(), "message", exception.getMessage())));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MissingServletRequestParameterException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<?> invalid(Exception exception) { return api(ApiException.invalid()); }

    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public ResponseEntity<?> missing(Exception exception) {
        return api(new ApiException("http_error", "요청 경로를 확인해 주세요.", 404));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<?> method(HttpRequestMethodNotSupportedException exception) {
        return api(new ApiException("http_error", "요청 방식을 확인해 주세요.", 405));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<?> media(HttpMediaTypeNotSupportedException exception) {
        return api(new ApiException("invalid_request", "JSON 형식으로 요청해 주세요.", 415));
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<?> storage(DataAccessException exception) {
        LOG.error("Database operation failed ({})", exception.getClass().getSimpleName());
        return api(new ApiException("storage_unavailable", "저장소를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.", 503));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> unexpected(Exception exception) {
        // Never log exception messages: providers may include secrets or submitted input.
        LOG.error("Request failed ({})", exception.getClass().getSimpleName());
        return api(new ApiException("internal_error", "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.", 500));
    }
}

package com.roomescape.support.error;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Map<ErrorCode, HttpStatus> STATUS_BY_CODE = Map.of(
            ErrorCode.RESERVATION_NOT_FOUND, HttpStatus.NOT_FOUND,
            ErrorCode.RESERVATION_CANCELLATION_DEADLINE_PASSED, HttpStatus.CONFLICT,
            ErrorCode.PAST_RESERVATION, HttpStatus.CONFLICT,
            ErrorCode.ACCESS_DENIED, HttpStatus.FORBIDDEN,
            ErrorCode.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR
    );

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ApiError> handle(BusinessException exception) {
        HttpStatus status = STATUS_BY_CODE.getOrDefault(
                exception.errorCode(),
                HttpStatus.INTERNAL_SERVER_ERROR
        );
        return ResponseEntity.status(status).body(new ApiError(
                exception.errorCode().name(),
                exception.getMessage()
        ));
    }
}

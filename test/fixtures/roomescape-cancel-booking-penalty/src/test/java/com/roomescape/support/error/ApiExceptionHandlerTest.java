package com.roomescape.support.error;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

class ApiExceptionHandlerTest {

    private final ApiExceptionHandler handler = new ApiExceptionHandler();

    @Test
    void cancellationDeadlineMapsToConflictAndStableCode() {
        ResponseEntity<ApiError> response = handler.handle(new BusinessException(
                ErrorCode.RESERVATION_CANCELLATION_DEADLINE_PASSED,
                "예약 시작 30분 전까지만 취소할 수 있습니다."
        ));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().code()).isEqualTo(
                "RESERVATION_CANCELLATION_DEADLINE_PASSED"
        );
    }
}

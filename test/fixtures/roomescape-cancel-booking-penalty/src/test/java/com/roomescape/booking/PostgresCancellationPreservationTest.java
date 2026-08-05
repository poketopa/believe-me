package com.roomescape.booking;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.roomescape.booking.application.ReservationService;
import com.roomescape.booking.domain.Reservation;
import com.roomescape.booking.domain.Waiting;
import com.roomescape.booking.infrastructure.ReservationRepository;
import com.roomescape.booking.infrastructure.WaitingRepository;
import com.roomescape.support.MutableClockTestConfiguration;
import com.roomescape.support.MutableClockTestConfiguration.MutableClock;
import com.roomescape.support.error.BusinessException;
import com.roomescape.support.error.ErrorCode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
@Import(MutableClockTestConfiguration.class)
@EnabledIfEnvironmentVariable(named = "ROOMESCAPE_POSTGRES_URL", matches = ".+")
class PostgresCancellationPreservationTest {

    private static final long OWNER_ID = 101L;
    private static final long STORE_ID = 10L;
    private static final LocalDate RESERVED_DATE = LocalDate.of(2026, 8, 6);
    private static final LocalTime START_AT = LocalTime.NOON;
    private static final Instant DEADLINE = LocalDateTime.of(RESERVED_DATE, START_AT)
            .atZone(ZoneId.of("Asia/Seoul"))
            .toInstant()
            .minusSeconds(30 * 60L);

    @Autowired
    private ReservationService reservationService;

    @Autowired
    private ReservationRepository reservationRepository;

    @Autowired
    private WaitingRepository waitingRepository;

    @Autowired
    private MutableClock clock;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private Long reservationId;

    @BeforeEach
    void setUp() {
        waitingRepository.deleteAll();
        reservationRepository.deleteAll();
        reservationId = reservationRepository.save(new Reservation(
                OWNER_ID,
                STORE_ID,
                RESERVED_DATE,
                START_AT
        )).getId();
        waitingRepository.saveAll(List.of(
                new Waiting(201L, STORE_ID, RESERVED_DATE, START_AT, 1),
                new Waiting(202L, STORE_ID, RESERVED_DATE, START_AT, 2)
        ));
        clock.setInstant(DEADLINE);
    }

    @Test
    void rejectedCancellationPreservesPostgresRowsAndWaitingOrder() {
        List<Map<String, Object>> reservationsBefore = reservationRows();
        List<Map<String, Object>> waitingsBefore = waitingRows();

        assertThatThrownBy(() -> reservationService.cancelOwned(OWNER_ID, reservationId))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(
                                ErrorCode.RESERVATION_CANCELLATION_DEADLINE_PASSED
                        )
                );

        assertThat(reservationRows()).isEqualTo(reservationsBefore);
        assertThat(waitingRows()).isEqualTo(waitingsBefore);
    }

    private List<Map<String, Object>> reservationRows() {
        return jdbcTemplate.queryForList("""
                select id, owner_id, store_id, reserved_date, start_at
                from reservations
                order by id
                """);
    }

    private List<Map<String, Object>> waitingRows() {
        return jdbcTemplate.queryForList("""
                select id, owner_id, store_id, reserved_date, start_at, queue_position
                from waitings
                order by queue_position, id
                """);
    }
}

package com.roomescape.booking;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.roomescape.booking.application.PromotionFailureSwitch;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;

@SpringBootTest
@Import(MutableClockTestConfiguration.class)
class ReservationServicePolicyTest {

    private static final long OWNER_ID = 101L;
    private static final long STORE_ID = 10L;
    private static final LocalDate RESERVED_DATE = LocalDate.of(2026, 8, 6);
    private static final LocalTime START_AT = LocalTime.NOON;
    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Seoul");
    private static final Instant START_INSTANT = LocalDateTime.of(
            RESERVED_DATE,
            START_AT
    ).atZone(BUSINESS_ZONE).toInstant();
    private static final Instant DEADLINE = START_INSTANT.minusSeconds(30 * 60L);

    @Autowired
    private ReservationService reservationService;

    @Autowired
    private ReservationRepository reservationRepository;

    @Autowired
    private WaitingRepository waitingRepository;

    @Autowired
    private PromotionFailureSwitch failureSwitch;

    @Autowired
    private MutableClock clock;

    private Long reservationId;

    @BeforeEach
    void setUp() {
        waitingRepository.deleteAll();
        reservationRepository.deleteAll();
        failureSwitch.reset();
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
    }

    @Test
    void ownerCanCancelStrictlyBeforeDeadlineAndFirstWaitingIsPromoted() {
        clock.setInstant(DEADLINE.minusNanos(1));

        reservationService.cancelOwned(OWNER_ID, reservationId);

        List<Reservation> reservations = reservationRepository.findAll();
        List<Waiting> waitings = waitingRepository.findAll();
        assertThat(reservations)
                .extracting(Reservation::getOwnerId)
                .containsExactly(201L);
        assertThat(waitings)
                .extracting(Waiting::getOwnerId, Waiting::getPosition)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(202L, 2));
    }

    @Test
    void ownerAtDeadlineIsRefusedAndStateIsPreserved() {
        clock.setInstant(DEADLINE);

        assertDeadlineRefusalPreservesState();
    }

    @Test
    void ownerAfterDeadlineIsRefusedAndStateIsPreserved() {
        clock.setInstant(DEADLINE.plusSeconds(1));

        assertDeadlineRefusalPreservesState();
    }

    @Test
    void managerCancellationIsExemptFromOwnerDeadline() {
        clock.setInstant(DEADLINE);

        reservationService.cancelManaged(STORE_ID, reservationId);

        assertThat(reservationRepository.findAll())
                .extracting(Reservation::getOwnerId)
                .containsExactly(201L);
    }

    @Test
    void managerStoreOwnershipIsPreserved() {
        clock.setInstant(DEADLINE);

        assertThatThrownBy(() -> reservationService.cancelManaged(999L, reservationId))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(ErrorCode.ACCESS_DENIED)
                );
        assertThat(reservationRepository.existsById(reservationId)).isTrue();
    }

    @Test
    void managerPastReservationRestrictionIsPreserved() {
        clock.setInstant(START_INSTANT.plusNanos(1));

        assertThatThrownBy(() -> reservationService.cancelManaged(STORE_ID, reservationId))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(
                                ErrorCode.PAST_RESERVATION
                        )
                );
        assertThat(reservationRepository.existsById(reservationId)).isTrue();
    }

    @Test
    void wrongOwnerPreservesReservationNotFoundContract() {
        clock.setInstant(DEADLINE.minusSeconds(1));

        assertThatThrownBy(() -> reservationService.cancelOwned(999L, reservationId))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(
                                ErrorCode.RESERVATION_NOT_FOUND
                        )
                );
        assertThat(reservationRepository.existsById(reservationId)).isTrue();
    }

    @Test
    void missingReservationUsesSameNotFoundContract() {
        clock.setInstant(DEADLINE.minusSeconds(1));

        assertThatThrownBy(() -> reservationService.cancelOwned(OWNER_ID, Long.MAX_VALUE))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(
                                ErrorCode.RESERVATION_NOT_FOUND
                        )
                );
        assertThat(reservationRepository.existsById(reservationId)).isTrue();
    }

    @Test
    void promotionFailureRollsBackReservationAndWaitingState() {
        clock.setInstant(DEADLINE.minusSeconds(1));
        failureSwitch.failNextPromotion();

        assertThatThrownBy(() -> reservationService.cancelOwned(OWNER_ID, reservationId))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("injected promotion failure");

        assertThat(reservationRepository.existsById(reservationId)).isTrue();
        assertThat(waitingRepository.findAll())
                .extracting(Waiting::getOwnerId, Waiting::getPosition)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(201L, 1),
                        org.assertj.core.groups.Tuple.tuple(202L, 2)
                );
    }

    private void assertDeadlineRefusalPreservesState() {
        assertThatThrownBy(() -> reservationService.cancelOwned(OWNER_ID, reservationId))
                .isInstanceOfSatisfying(BusinessException.class, exception ->
                        assertThat(exception.errorCode()).isEqualTo(
                                ErrorCode.RESERVATION_CANCELLATION_DEADLINE_PASSED
                        )
                );
        assertThat(reservationRepository.existsById(reservationId)).isTrue();
        assertThat(waitingRepository.findAll())
                .extracting(Waiting::getOwnerId, Waiting::getPosition)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(201L, 1),
                        org.assertj.core.groups.Tuple.tuple(202L, 2)
                );
    }
}

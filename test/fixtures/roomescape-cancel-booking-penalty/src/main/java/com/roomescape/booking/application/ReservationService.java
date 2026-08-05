package com.roomescape.booking.application;

import com.roomescape.booking.domain.Reservation;
import com.roomescape.booking.infrastructure.ReservationRepository;
import com.roomescape.support.error.BusinessException;
import com.roomescape.support.error.ErrorCode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ReservationService {

    static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Seoul");
    static final Duration OWNER_CANCELLATION_WINDOW = Duration.ofMinutes(30);

    private final ReservationRepository reservationRepository;
    private final WaitingPromotionService waitingPromotionService;
    private final Clock clock;

    public ReservationService(
            ReservationRepository reservationRepository,
            WaitingPromotionService waitingPromotionService,
            Clock clock
    ) {
        this.reservationRepository = reservationRepository;
        this.waitingPromotionService = waitingPromotionService;
        this.clock = clock;
    }

    @Transactional
    public void cancelOwned(Long ownerId, Long reservationId) {
        Reservation reservation = reservationRepository.findOwnedByIdForUpdate(
                reservationId,
                ownerId
        ).orElseThrow(this::reservationNotFound);
        validateOwnerDeadline(reservation, Instant.now(clock));
        cancelAndPromote(reservation);
    }

    @Transactional
    public void cancelManaged(Long managerStoreId, Long reservationId) {
        Reservation reservation = reservationRepository.findManagedByIdForUpdate(
                reservationId,
                managerStoreId
        ).orElseThrow(() -> new BusinessException(
                ErrorCode.ACCESS_DENIED,
                "담당 매장의 예약만 관리할 수 있습니다."
        ));
        validateNotPast(reservation, Instant.now(clock));
        cancelAndPromote(reservation);
    }

    private void validateOwnerDeadline(Reservation reservation, Instant now) {
        Instant deadline = startInstant(reservation).minus(OWNER_CANCELLATION_WINDOW);
        if (!now.isBefore(deadline)) {
            throw new BusinessException(
                    ErrorCode.RESERVATION_CANCELLATION_DEADLINE_PASSED,
                    "예약 시작 30분 전까지만 취소할 수 있습니다."
            );
        }
    }

    private void validateNotPast(Reservation reservation, Instant now) {
        if (startInstant(reservation).isBefore(now)) {
            throw new BusinessException(
                    ErrorCode.PAST_RESERVATION,
                    "지난 예약은 취소할 수 없습니다."
            );
        }
    }

    private Instant startInstant(Reservation reservation) {
        return LocalDateTime.of(
                reservation.getReservedDate(),
                reservation.getStartAt()
        ).atZone(BUSINESS_ZONE).toInstant();
    }

    private void cancelAndPromote(Reservation reservation) {
        Long storeId = reservation.getStoreId();
        var reservedDate = reservation.getReservedDate();
        var startAt = reservation.getStartAt();
        reservationRepository.delete(reservation);
        reservationRepository.flush();
        waitingPromotionService.promoteFirst(storeId, reservedDate, startAt);
    }

    private BusinessException reservationNotFound() {
        return new BusinessException(
                ErrorCode.RESERVATION_NOT_FOUND,
                "예약을 찾을 수 없습니다."
        );
    }
}

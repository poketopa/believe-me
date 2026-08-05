package com.roomescape.booking.application;

import com.roomescape.booking.domain.Reservation;
import com.roomescape.booking.domain.Waiting;
import com.roomescape.booking.infrastructure.ReservationRepository;
import com.roomescape.booking.infrastructure.WaitingRepository;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class WaitingPromotionService {

    private final WaitingRepository waitingRepository;
    private final ReservationRepository reservationRepository;
    private final PromotionFailureSwitch failureSwitch;

    public WaitingPromotionService(
            WaitingRepository waitingRepository,
            ReservationRepository reservationRepository,
            PromotionFailureSwitch failureSwitch
    ) {
        this.waitingRepository = waitingRepository;
        this.reservationRepository = reservationRepository;
        this.failureSwitch = failureSwitch;
    }

    public void promoteFirst(Long storeId, LocalDate reservedDate, LocalTime startAt) {
        List<Waiting> waitings = waitingRepository.findSlotForUpdate(
                storeId,
                reservedDate,
                startAt
        );
        if (waitings.isEmpty()) {
            return;
        }
        if (failureSwitch.shouldFail()) {
            throw new IllegalStateException("injected promotion failure");
        }
        Waiting first = waitings.getFirst();
        reservationRepository.save(new Reservation(
                first.getOwnerId(),
                first.getStoreId(),
                first.getReservedDate(),
                first.getStartAt()
        ));
        waitingRepository.delete(first);
    }
}

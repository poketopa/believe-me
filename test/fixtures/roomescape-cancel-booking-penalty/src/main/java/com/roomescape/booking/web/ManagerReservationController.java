package com.roomescape.booking.web;

import com.roomescape.booking.application.ReservationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/manager/reservations")
public class ManagerReservationController {

    private final ReservationService reservationService;

    public ManagerReservationController(ReservationService reservationService) {
        this.reservationService = reservationService;
    }

    @DeleteMapping("/{reservationId}")
    public ResponseEntity<Void> cancel(
            @RequestHeader("X-Manager-Store-Id") Long managerStoreId,
            @PathVariable Long reservationId
    ) {
        reservationService.cancelManaged(managerStoreId, reservationId);
        return ResponseEntity.noContent().build();
    }
}

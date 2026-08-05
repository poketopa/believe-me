package com.roomescape.booking.web;

import com.roomescape.booking.application.ReservationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/reservations")
public class ReservationController {

    private final ReservationService reservationService;

    public ReservationController(ReservationService reservationService) {
        this.reservationService = reservationService;
    }

    @DeleteMapping("/{reservationId}")
    public ResponseEntity<Void> cancel(
            @RequestHeader("X-Member-Id") Long memberId,
            @PathVariable Long reservationId
    ) {
        reservationService.cancelOwned(memberId, reservationId);
        return ResponseEntity.noContent().build();
    }
}

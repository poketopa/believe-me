package com.roomescape.booking.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDate;
import java.time.LocalTime;

@Entity
@Table(name = "reservations")
public class Reservation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long ownerId;

    @Column(nullable = false)
    private Long storeId;

    @Column(nullable = false)
    private LocalDate reservedDate;

    @Column(nullable = false)
    private LocalTime startAt;

    protected Reservation() {
    }

    public Reservation(Long ownerId, Long storeId, LocalDate reservedDate, LocalTime startAt) {
        this.ownerId = ownerId;
        this.storeId = storeId;
        this.reservedDate = reservedDate;
        this.startAt = startAt;
    }

    public Long getId() {
        return id;
    }

    public Long getOwnerId() {
        return ownerId;
    }

    public Long getStoreId() {
        return storeId;
    }

    public LocalDate getReservedDate() {
        return reservedDate;
    }

    public LocalTime getStartAt() {
        return startAt;
    }
}

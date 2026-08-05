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
@Table(name = "waitings")
public class Waiting {

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

    @Column(name = "queue_position", nullable = false)
    private int position;

    protected Waiting() {
    }

    public Waiting(
            Long ownerId,
            Long storeId,
            LocalDate reservedDate,
            LocalTime startAt,
            int position
    ) {
        this.ownerId = ownerId;
        this.storeId = storeId;
        this.reservedDate = reservedDate;
        this.startAt = startAt;
        this.position = position;
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

    public int getPosition() {
        return position;
    }
}

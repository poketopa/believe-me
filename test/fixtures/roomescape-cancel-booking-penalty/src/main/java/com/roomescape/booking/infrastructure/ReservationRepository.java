package com.roomescape.booking.infrastructure;

import com.roomescape.booking.domain.Reservation;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReservationRepository extends JpaRepository<Reservation, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Reservation r where r.id = :id and r.ownerId = :ownerId")
    Optional<Reservation> findOwnedByIdForUpdate(
            @Param("id") Long id,
            @Param("ownerId") Long ownerId
    );

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Reservation r where r.id = :id and r.storeId = :storeId")
    Optional<Reservation> findManagedByIdForUpdate(
            @Param("id") Long id,
            @Param("storeId") Long storeId
    );
}

package com.roomescape.booking.infrastructure;

import com.roomescape.booking.domain.Waiting;
import jakarta.persistence.LockModeType;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface WaitingRepository extends JpaRepository<Waiting, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
            select w from Waiting w
            where w.storeId = :storeId
              and w.reservedDate = :reservedDate
              and w.startAt = :startAt
            order by w.position asc
            """)
    List<Waiting> findSlotForUpdate(
            @Param("storeId") Long storeId,
            @Param("reservedDate") LocalDate reservedDate,
            @Param("startAt") LocalTime startAt
    );
}

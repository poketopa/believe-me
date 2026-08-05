package com.roomescape.support;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration(proxyBeanMethods = false)
public class MutableClockTestConfiguration {

    @Bean
    @Primary
    MutableClock mutableClock() {
        return new MutableClock(
                Instant.parse("2026-08-06T00:00:00Z"),
                ZoneId.of("UTC")
        );
    }

    public static final class MutableClock extends Clock {

        private final AtomicReference<Instant> instant;
        private final ZoneId zone;

        public MutableClock(Instant instant, ZoneId zone) {
            this.instant = new AtomicReference<>(Objects.requireNonNull(instant));
            this.zone = Objects.requireNonNull(zone);
        }

        public void setInstant(Instant value) {
            instant.set(Objects.requireNonNull(value));
        }

        @Override
        public ZoneId getZone() {
            return zone;
        }

        @Override
        public Clock withZone(ZoneId requestedZone) {
            return new MutableClock(instant(), requestedZone);
        }

        @Override
        public Instant instant() {
            return instant.get();
        }
    }
}

package com.roomescape.booking.application;

import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Component;

@Component
public class PromotionFailureSwitch {

    private final AtomicBoolean failNext = new AtomicBoolean();

    public void failNextPromotion() {
        failNext.set(true);
    }

    public void reset() {
        failNext.set(false);
    }

    boolean shouldFail() {
        return failNext.getAndSet(false);
    }
}

package com.drivemate.api;

import java.time.LocalDate;
import java.time.ZoneOffset;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class PaidApiBudget {
    private final Store store;
    private final int dailyLimit;

    public PaidApiBudget(Store store, @Value("${DRIVEMATE_LLM_DAILY_LIMIT:20}") int dailyLimit) {
        if (dailyLimit < 0 || dailyLimit > 1000) throw new IllegalArgumentException("Paid API daily limit must be 0..1000");
        this.store = store;
        this.dailyLimit = dailyLimit;
    }

    public void consume() {
        store.rateLimit("llm-global:" + LocalDate.now(ZoneOffset.UTC), dailyLimit, 86_400);
    }
}

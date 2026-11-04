package com.drivemate.api.providers;

import static com.drivemate.api.providers.ProviderSupport.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class GoogleCalendarProvider {
    private final ProviderHttp http;
    private final ObjectMapper mapper;
    public GoogleCalendarProvider(ProviderHttp http, ObjectMapper mapper) { this.http = http; this.mapper = mapper; }

    public Map<String, Object> listEvents(String mode, String accessToken, OffsetDateTime minimum, OffsetDateTime maximum) {
        if (!minimum.toInstant().isBefore(maximum.toInstant())) throw new IllegalArgumentException("Invalid calendar window");
        String token = credential(mode, accessToken);
        Map<String, String> params = new LinkedHashMap<>(Map.of("timeMin", minimum.toString(), "timeMax", maximum.toString(),
            "singleEvents", "true", "orderBy", "startTime", "showDeleted", "false", "maxResults", "250",
            "fields", "timeZone,nextPageToken,items(id,summary,start,end,location,status,recurringEventId)"));
        List<Map<String, Object>> events = new ArrayList<>();
        Map<String, Map<String, Object>> byId = new HashMap<>(); Set<String> pageTokens = new HashSet<>();
        String calendarZone = null; int cancelled = 0;
        try {
            for (int pageNumber = 1; pageNumber <= 20; pageNumber++) {
                JsonNode page = mode.equals("mock") ? mockPage(minimum) : http.get("https://www.googleapis.com/calendar/v3/calendars/primary/events", params, "Bearer " + token);
                String zone = zone(page.get("timeZone"));
                if (calendarZone != null && !calendarZone.equals(zone)) throw new IllegalArgumentException("Timezone changed");
                calendarZone = zone; JsonNode items = page.get("items");
                if (items == null || !items.isArray() || items.size() > 2500) throw new IllegalArgumentException("Invalid events list");
                for (JsonNode item : items) {
                    if (!item.isObject()) throw new IllegalArgumentException();
                    String status = item.has("status") ? text(item.get("status"), 30, false) : "confirmed";
                    if (status.equals("cancelled")) { cancelled++; continue; }
                    if (!Set.of("confirmed", "tentative").contains(status)) throw new IllegalArgumentException();
                    Map<String, Object> event = normalizeEvent(item, zone);
                    String id = (String) event.get("id");
                    if (byId.containsKey(id)) {
                        if (!byId.get(id).equals(event)) throw new IllegalArgumentException("Conflicting event");
                        continue;
                    }
                    byId.put(id, event);
                    if (overlaps(event, minimum.toInstant(), maximum.toInstant())) events.add(event);
                }
                JsonNode next = page.get("nextPageToken");
                if (next == null || next.isNull()) {
                    Map<String, Object> result = metadata("google_calendar", mode, http.isTestTransport());
                    result.putAll(map("events", events, "timezone", zone, "pages_fetched", pageNumber, "cancelled_count", cancelled, "complete", true));
                    return result;
                }
                String pageToken = text(next, 4096, false);
                if (!pageTokens.add(pageToken)) throw new IllegalArgumentException("Repeated page token");
                params.put("pageToken", pageToken);
            }
            throw new IllegalArgumentException("Page limit exceeded");
        } catch (IllegalArgumentException | DateTimeException | NullPointerException error) { throw malformed(); }
    }

    private static String zone(JsonNode value) { String name = text(value, 100, false); ZoneId.of(name); return name; }
    private static String date(JsonNode value) {
        String result = text(value, 10, false);
        if (!result.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new IllegalArgumentException("Invalid date");
        LocalDate.parse(result); return result;
    }
    static OffsetDateTime instant(JsonNode value, JsonNode explicitZone) {
        String text = text(value, 60, false);
        if (!text.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?")) throw new IllegalArgumentException("Invalid datetime");
        if (text.endsWith("Z") || text.substring(19).matches(".*[+-][0-9]{2}:[0-9]{2}")) return OffsetDateTime.parse(text);
        if (explicitZone == null) throw new IllegalArgumentException("Explicit timezone required");
        LocalDateTime local = LocalDateTime.parse(text); ZoneId zone = ZoneId.of(zone(explicitZone));
        List<ZoneOffset> offsets = zone.getRules().getValidOffsets(local);
        if (offsets.size() != 1) throw new IllegalArgumentException("Ambiguous or missing local time");
        return OffsetDateTime.of(local, offsets.get(0));
    }
    static Map<String, Object> normalizeEvent(JsonNode item, String calendarZone) {
        String id = text(item.get("id"), 1024, false);
        String title = item.has("summary") ? text(item.get("summary"), 4000, true) : "";
        if (title.isEmpty()) title = "(제목 없음)";
        String location = item.hasNonNull("location") ? text(item.get("location"), 4000, true) : null;
        if (location != null && location.isEmpty()) location = null;
        JsonNode start = item.get("start"), end = item.get("end");
        if (start == null || end == null || !start.isObject() || !end.isObject()) throw new IllegalArgumentException();
        String startZone = start.has("timeZone") ? zone(start.get("timeZone")) : calendarZone;
        String endZone = end.has("timeZone") ? zone(end.get("timeZone")) : calendarZone;
        boolean allDay = start.has("date"); String startDate = null, endDate = null, startAt = null, endAt = null;
        if (allDay) {
            if (start.has("dateTime") || end.has("dateTime")) throw new IllegalArgumentException();
            startDate = date(start.get("date")); endDate = date(end.get("date"));
            if (!LocalDate.parse(startDate).isBefore(LocalDate.parse(endDate))) throw new IllegalArgumentException();
        } else {
            if (end.has("date")) throw new IllegalArgumentException();
            OffsetDateTime first = instant(start.get("dateTime"), start.get("timeZone")), last = instant(end.get("dateTime"), end.get("timeZone"));
            if (!first.toInstant().isBefore(last.toInstant())) throw new IllegalArgumentException();
            startAt = first.format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME); endAt = last.format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME);
        }
        return map("id", id, "title", title, "start_at", startAt, "end_at", endAt, "start_date", startDate, "end_date", endDate,
            "all_day", allDay, "location", location, "timezone", startZone, "end_timezone", endZone,
            "route_eligible", !allDay && location != null, "recurring_event_id", item.has("recurringEventId") ? text(item.get("recurringEventId"), 1024, false) : null);
    }
    static boolean overlaps(Map<String, Object> event, Instant minimum, Instant maximum) {
        Instant start, end;
        if ((boolean) event.get("all_day")) {
            ZoneId zone = ZoneId.of((String) event.get("timezone"));
            start = LocalDate.parse((String) event.get("start_date")).atStartOfDay(zone).toInstant();
            end = LocalDate.parse((String) event.get("end_date")).atStartOfDay(zone).toInstant();
        } else {
            start = OffsetDateTime.parse((String) event.get("start_at")).toInstant(); end = OffsetDateTime.parse((String) event.get("end_at")).toInstant();
        }
        return end.isAfter(minimum) && start.isBefore(maximum);
    }
    private JsonNode mockPage(OffsetDateTime minimum) {
        LocalDate day = minimum.atZoneSameInstant(ZoneId.of("Asia/Seoul")).toLocalDate().plusDays(1);
        OffsetDateTime start = day.atTime(10, 0).atZone(ZoneId.of("Asia/Seoul")).toOffsetDateTime();
        return mapper.valueToTree(map("timeZone", "Asia/Seoul", "items", List.of(
            map("id", "mock-meeting-" + day, "summary", "[예시] 조별 프로젝트 회의", "location", "서울시청", "start", map("dateTime", start.format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)), "end", map("dateTime", start.plusHours(1).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME))),
            map("id", "mock-all-day-" + day, "summary", "[예시] 프로젝트 자료 정리", "start", map("date", day.toString()), "end", map("date", day.plusDays(1).toString())),
            map("id", "mock-no-location-" + day, "summary", "[예시] 온라인 회의 · 장소 없음", "start", map("dateTime", start.plusHours(3).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)), "end", map("dateTime", start.plusHours(4).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME))))));
    }
}

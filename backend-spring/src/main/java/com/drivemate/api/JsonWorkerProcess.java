package com.drivemate.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/** Shared process budget for price and document analysis. */
final class JsonWorkerProcess implements AutoCloseable {
    static final int MAX_OUTPUT_BYTES = 512 * 1024;
    private static final Semaphore CAPACITY = new Semaphore(2);
    private final ObjectMapper json;
    private final Set<Process> processes = ConcurrentHashMap.newKeySet();
    private final ExecutorService readers = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "analysis-output");
        thread.setDaemon(true);
        return thread;
    });

    @FunctionalInterface interface Starter { Process start(List<String> command) throws IOException; }
    record Result(int exitCode, JsonNode body) { }

    JsonWorkerProcess(ObjectMapper json) { this.json = json; }

    Result run(List<String> command, JsonNode request, int timeoutSeconds, Starter starter, String prefix) {
        if (!CAPACITY.tryAcquire()) {
            throw new ApiException(prefix + "_busy", "다른 분석을 처리하고 있어요. 잠시 후 다시 시도해 주세요.", 429);
        }
        Process process = null;
        Future<byte[]> output = null;
        try {
            process = starter.start(command);
            processes.add(process);
            Process running = process;
            output = readers.submit(() -> {
                byte[] bytes = running.getInputStream().readNBytes(MAX_OUTPUT_BYTES + 1);
                if (bytes.length > MAX_OUTPUT_BYTES) {
                    kill(running);
                    throw new IOException("Worker output limit exceeded");
                }
                return bytes;
            });
            try (var input = process.getOutputStream()) {
                input.write(request.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                throw new ApiException(prefix + "_timeout", "분석 시간이 초과됐어요. 다시 시도해 주세요.", 504);
            }
            JsonNode response = json.readTree(output.get(2, TimeUnit.SECONDS));
            if (response == null || !response.isObject()) throw new IOException("Invalid worker JSON");
            return new Result(process.exitValue(), response);
        } catch (ApiException exception) {
            throw exception;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new ApiException(prefix + "_interrupted", "분석이 중단됐어요. 다시 시도해 주세요.", 503);
        } catch (Exception exception) {
            throw new ApiException(prefix + "_failed", "분석을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
        } finally {
            if (process != null) {
                kill(process);
                processes.remove(process);
            }
            if (output != null) output.cancel(true);
            CAPACITY.release();
        }
    }

    private static void kill(Process process) {
        try { process.descendants().forEach(ProcessHandle::destroyForcibly); }
        catch (UnsupportedOperationException ignored) { }
        process.destroyForcibly();
        try { process.getInputStream().close(); } catch (IOException ignored) { }
        try { process.getOutputStream().close(); } catch (IOException ignored) { }
    }

    @Override public void close() {
        processes.forEach(JsonWorkerProcess::kill);
        readers.shutdownNow();
    }
}

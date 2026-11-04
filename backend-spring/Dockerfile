FROM eclipse-temurin:17-jdk-jammy AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY backend-spring/pom.xml backend-spring/mvnw ./
RUN chmod +x mvnw && ./mvnw -q dependency:go-offline
COPY backend-spring/src ./src
RUN ./mvnw -q -DskipTests package

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless python3 python3-venv ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 drivemate
WORKDIR /opt/drivemate
COPY backend/requirements-ml.txt backend/requirements-rag.txt ./backend/
RUN python3 -m venv /opt/drivemate/venv \
    && /opt/drivemate/venv/bin/pip install --no-cache-dir -r backend/requirements-ml.txt -r backend/requirements-rag.txt
COPY backend/scripts/onbid_model.py backend/scripts/onbid_explain.py backend/scripts/onbid_worker.py backend/scripts/document_rag.py ./backend/scripts/
COPY --from=build /build/target/drivemate-api-0.2.0.jar ./app.jar
RUN mkdir -p data model && chown -R drivemate:drivemate /opt/drivemate
USER drivemate
ENV SERVER_ADDRESS=0.0.0.0 SERVER_PORT=18085 \
    DRIVEMATE_PYTHON=/opt/drivemate/venv/bin/python \
    DRIVEMATE_MODEL_BUNDLE=/opt/drivemate/model/model_bundle.joblib \
    DRIVEMATE_ML_WORKER=/opt/drivemate/backend/scripts/onbid_worker.py \
    DRIVEMATE_RAG_WORKER=/opt/drivemate/backend/scripts/document_rag.py
EXPOSE 18085
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD curl -fsS http://127.0.0.1:18085/api/v1/health > /dev/null || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=65", "-jar", "/opt/drivemate/app.jar"]

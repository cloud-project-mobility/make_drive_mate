FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/drivemate/venv/bin:$PATH \
    AWS_EC2_METADATA_DISABLED=true \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2

RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless python3 python3-venv nginx ca-certificates curl libgomp1 libpcre2-8-0 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge 10.42-4ubuntu2.2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 drivemate \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /opt/drivemate --shell /usr/sbin/nologin drivemate \
    && mkdir -p /opt/drivemate/runtime /srv/drivemate-web /etc/drivemate \
    && chown 10001:10001 /opt/drivemate/runtime /srv/drivemate-web \
    && curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /etc/drivemate/rds-global-bundle.pem \
    && chmod 0644 /etc/drivemate/rds-global-bundle.pem \
    && python3 -m venv /opt/drivemate/venv

COPY requirements/ /tmp/drivemate-requirements/
RUN /opt/drivemate/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
      -r /tmp/drivemate-requirements/ml.txt \
      -r /tmp/drivemate-requirements/rag.txt \
      -r /tmp/drivemate-requirements/aws.txt \
    && /opt/drivemate/venv/bin/pip check \
    && /opt/drivemate/venv/bin/python -m pip uninstall --yes pip \
    && apt-get purge -y python3-pip-whl python3-venv python3.12-venv \
    && /opt/drivemate/venv/bin/python -c "import importlib.util; assert importlib.util.find_spec('pip') is None" \
    && rm -rf /tmp/drivemate-requirements

COPY app/ /opt/drivemate/
COPY container/ /opt/drivemate/container/
RUN test -s /opt/drivemate/backend-spring/target/drivemate-api-0.2.0.jar \
    && test -s /opt/drivemate/dist/index.html \
    && test ! -e /opt/drivemate/backend/data \
    && chmod -R a+rX,go-w /opt/drivemate/backend-spring /opt/drivemate/backend \
      /opt/drivemate/infra /opt/drivemate/dist /opt/drivemate/container \
    && chmod 0644 /opt/drivemate/image-manifest.json

VOLUME ["/opt/drivemate/runtime", "/srv/drivemate-web", "/tmp"]
WORKDIR /opt/drivemate
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/drivemate/venv/bin/python", "/opt/drivemate/container/entrypoint.py"]
CMD ["api"]

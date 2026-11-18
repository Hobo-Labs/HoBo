FROM mcr.microsoft.com/dotnet/sdk@sha256:4f4992f8f302150e4adb5e78c324731e968493a30c0638985ba29cb42a858cd6 AS builder
COPY host-ca.crt /etc/ssl/certs/ca-certificates.crt
RUN apk add --no-cache python3 py3-pip
COPY src ./src
COPY restler ./restler
COPY build-restler.py .
RUN python3 build-restler.py --dest_dir /build
RUN python3 -m compileall -b /build/engine
FROM mcr.microsoft.com/dotnet/aspnet@sha256:862a092806bace0c5219879fdbc42da770ac4975a35499ecadc9ede79a21d244 AS target
LABEL org.opencontainers.image.revision="6d984deedbc54aad957fa3da0c7e9e5df23a2aee"
COPY host-ca.crt /etc/ssl/certs/ca-certificates.crt
RUN apk add --no-cache python3 py3-pip
RUN python3 -m venv /venv
RUN /venv/bin/pip install applicationinsights==0.11.10 certifi==2026.10.23 charset-normalizer==3.5.2 idna==3.20 requests==2.34.2 urllib3==2.8.0
ENV PATH="/venv/bin:$PATH"
COPY --from=builder /build /RESTler

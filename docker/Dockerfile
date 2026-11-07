# pdfkiln on Debian 13 slim, installed from the Debian package of
# scripts/deb.ts, run by an unprivileged user, with Chromium's sandbox on.
#
#   node dist/scripts/package.js && node dist/scripts/deb.js
#   docker build -t pdfkiln -f docker/Dockerfile dist/package
#   docker run --rm -i pdfkiln wkhtmltopdf - - < page.html > page.pdf
#
# The context may hold the packages of both architectures: each platform's
# build takes its own (TARGETARCH, set by BuildKit), so that docker.yml
# builds the amd64 and arm64 images from one context.
#
# The entry point is pdfkiln: "wkhtmltopdf" or "wkhtmltoimage" as first
# argument switches to the compatible mode. Chromium's sandbox needs README.md's seccomp profile.
FROM debian:13-slim
ARG TARGETARCH

# The package is mounted for the install, not copied: a COPY would keep its
# 100 MB in a layer of its own, whatever removes it after. Without
# recommendations, the package's one is named: emoji in colour (11 MB).
RUN --mount=type=bind,target=/context \
    apt-get update \
 && apt-get install -y --no-install-recommends /context/pdfkiln_*_${TARGETARCH}.deb fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 pdfkiln

USER pdfkiln
WORKDIR /home/pdfkiln
ENTRYPOINT ["pdfkiln"]
CMD ["--help"]

#!/usr/bin/env bash
# The Odoo proof in Odoo's official Docker image (odoo:<ODOO_TAG>: Ubuntu,
# with the official wkhtmltopdf 0.12.6.1-3), run as its README runs it:
# PostgreSQL in a container named db, the filestore in a volume. The demo
# database prints the documents of docs.py through Odoo's route (print.py,
# from the host), once per setup:
# - wkhtmltopdf-0.12.6: the image as published, for reference;
# - pdfkiln: an image built FROM it with PDFKiln's Debian package
#   (PDFKILN_DEB, or the APT repository when it is empty), run with
#   docker/seccomp.json, the profile the README gives for Chromium's sandbox;
# - pdfkiln-workers: the same, with --workers 2;
# - pdfkiln-default-seccomp: the same under Docker's default profile, where
#   Chromium's sandbox cannot start: Odoo's log must say why.
# Exits 1 unless PDFKiln prints every document with the profile, in both
# modes, and names the cause under the default profile.
#
#   test/odoo/docker.sh <out dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$1"
tag="${ODOO_TAG:-20.0}"
image="odoo:$tag"
mkdir -p "$out"
# The odoo user of the containers writes docs.json here.
chmod 777 "$out"

docker pull -q "$image" > /dev/null
docker network create odoo-proof > /dev/null
docker run -d --name db --network odoo-proof -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD=odoo -e POSTGRES_DB=postgres postgres:17 > /dev/null
docker volume create odoo-data > /dev/null
# The entrypoint's defaults: host db, user and password odoo.
run=(--network odoo-proof -v odoo-data:/var/lib/odoo -v "$out:/out")

build="$(mktemp -d)"
if [ -n "${PDFKILN_DEB:-}" ]; then
  cp "$PDFKILN_DEB" "$build/pdfkiln.deb"
  how="the Debian package built from the commit"
  cat > "$build/Dockerfile" <<EOF
FROM $image
USER root
COPY pdfkiln.deb /tmp/pdfkiln.deb
RUN apt-get update && apt-get install -y --no-install-recommends /tmp/pdfkiln.deb && rm -rf /var/lib/apt/lists/* /tmp/pdfkiln.deb
USER odoo
EOF
else
  how="apt install pdfkiln, from https://apt.pdfkiln.org"
  cat > "$build/Dockerfile" <<EOF
FROM $image
USER root
RUN curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc > /usr/share/keyrings/pdfkiln-archive-keyring.asc \\
  && printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' > /etc/apt/sources.list.d/pdfkiln.sources \\
  && apt-get update && apt-get install -y --no-install-recommends pdfkiln && rm -rf /var/lib/apt/lists/*
USER odoo
EOF
fi
cp "$build/Dockerfile" "$out/Dockerfile"
docker build -q -t odoo-pdfkiln "$build" > /dev/null

docker run --rm "${run[@]}" "$image" odoo -d odoo -i sale_management,account,stock,purchase --with-demo --stop-after-init > "$out/init.log" 2>&1
docker run --rm -i "${run[@]}" -e ODOO_PROOF_DOCS=/out/docs.json "$image" odoo shell -d odoo --no-http --log-level warn < "$here/docs.py"

python3 - "$out/platform.json" "odoo-image" "$tag" "" "$(dpkg --print-architecture)" "$tag" \
  "$(docker run --rm --entrypoint odoo "$image" --version)" "$(docker run --rm --entrypoint python3 "$image" -V)" "$(docker exec db postgres -V)" <<'EOF'
import json, sys
keys = ['id', 'version', 'codename', 'arch', 'odoo', 'odoo_commit', 'python', 'postgresql']
json.dump(dict(zip(keys, sys.argv[2:])), open(sys.argv[1], 'w'), indent=2)
EOF

# engine <name> <version> <note>
engine() {
  mkdir -p "$out/$1"
  python3 -c 'import json, sys; print(json.dumps({"engine": sys.argv[1], "installed": True, "version": sys.argv[2], "note": sys.argv[3]}))' "$@" > "$out/$1/engine.json"
}

# serve <name> <image> [docker options...] [-- odoo options...]: Odoo
# started, the documents printed from the host, Odoo removed.
serve() {
  local name="$1" img="$2"
  shift 2
  local opts=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do opts+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  docker run -d --name odoo-proof-server -p 127.0.0.1:8069:8069 "${run[@]}" "${opts[@]}" "$img" odoo "$@" > /dev/null
  for _ in $(seq 120); do curl -fs -o /dev/null http://127.0.0.1:8069/web/login && break; sleep 1; done
  python3 "$here/print.py" "$out/docs.json" "$out/$name" "$name" || true
  docker logs odoo-proof-server > "$out/$name/odoo.log" 2>&1
  docker rm -f odoo-proof-server > /dev/null
}

seccomp="seccomp=$root/docker/seccomp.json"
engine wkhtmltopdf-0.12.6 "$(docker run --rm --entrypoint wkhtmltopdf "$image" --version)" "the wkhtmltopdf of $image, as published"
serve wkhtmltopdf-0.12.6 "$image"
version="$(docker run --rm --entrypoint wkhtmltopdf odoo-pdfkiln --version)"
engine pdfkiln "$version" "$how, FROM $image; --security-opt $seccomp"
serve pdfkiln odoo-pdfkiln --security-opt "$seccomp"
engine pdfkiln-workers "$version" "$how, FROM $image; --security-opt $seccomp; Odoo with --workers 2"
serve pdfkiln-workers odoo-pdfkiln --security-opt "$seccomp" -- --workers 2
engine pdfkiln-default-seccomp "$version" "$how, FROM $image; Docker's default seccomp profile"
serve pdfkiln-default-seccomp odoo-pdfkiln
grep -h -m 3 -i 'chromium\|sandbox' "$out/pdfkiln-default-seccomp/odoo.log" | cut -c 1-400 > "$out/pdfkiln-default-seccomp/chromium.txt" || true

python3 "$here/summary.py" "$out"
cat "$out/pdfkiln-default-seccomp/chromium.txt"
for name in pdfkiln pdfkiln-workers; do
  python3 -c 'import json, sys; rows = json.load(open(sys.argv[1])); sys.exit(0 if rows and all(r["pdf"] for r in rows) else 1)' "$out/$name/print.json"
done
grep -q 'refuses the user namespaces' "$out/pdfkiln-default-seccomp/chromium.txt"

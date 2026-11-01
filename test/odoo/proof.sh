#!/usr/bin/env bash
# The Odoo proof on one platform, run as root in a container of its image
# (debian:trixie, ubuntu:24.04, ubuntu:26.04: the three Odoo 20 supports).
# Odoo comes from git in a venv, as its documentation installs it from
# source, with the distribution's PostgreSQL. Its demo database prints
# the documents of docs.py through its own route (print.py), once per
# engine, the server restarted each time (Odoo looks for the engine once
# per process):
# - wkhtmltopdf from the distribution, where there is one (Ubuntu 24.04:
#   0.12.6 without patched qt);
# - wkhtmltopdf 0.12.6.1-3 with patched qt, the official package of the
#   nearest release (bookworm for Debian, jammy for Ubuntu), if it installs;
# - Paper Muncher v0.9.0, the engine of Odoo 20's base_report_paper_muncher
#   (packages for amd64 only);
# - PDFKiln: the Debian package PDFKILN_DEB, or the APT repository as the
#   README gives it when PDFKILN_DEB is empty; in Odoo's default threaded
#   mode, then with --workers 2, as in production.
# Exits 1 unless PDFKiln prints every document in both modes.
#
#   test/odoo/proof.sh <out dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"
mkdir -p "$out"
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
arch="$(dpkg --print-architecture)"
branch="${ODOO_BRANCH:-20.0}"
home=/home/odoo
odoo=("$home/venv/bin/python" "$home/src/odoo-bin")

apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git postgresql \
  python3-venv python3-dev build-essential libpq-dev libldap2-dev libsasl2-dev fonts-dejavu-core fontconfig > /dev/null

useradd -m -s /bin/bash odoo
chown odoo "$out"
as_odoo() { runuser -u odoo -- env HOME="$home" "$@"; }
pg_ctlcluster "$(ls /etc/postgresql)" main start
runuser -u postgres -- createuser -s odoo

as_odoo git clone -q --depth 1 --branch "$branch" https://github.com/odoo/odoo.git "$home/src"
as_odoo python3 -m venv "$home/venv"
as_odoo "$home/venv/bin/pip" install -q --upgrade pip wheel
as_odoo "$home/venv/bin/pip" install -q -r "$home/src/requirements.txt"
cat > "$home/odoo.conf" <<EOF
[options]
db_user = odoo
addons_path = $home/src/addons,$home/src/odoo/addons
data_dir = $home/data
http_interface = 127.0.0.1
http_port = 8069
workers = 0
EOF
as_odoo "${odoo[@]}" server -c "$home/odoo.conf" -d odoo -i sale_management,account,stock,purchase,base_report_paper_muncher \
  --with-demo --stop-after-init --logfile "$out/init.log"
as_odoo env ODOO_PROOF_DOCS="$home/docs.json" "${odoo[@]}" shell -c "$home/odoo.conf" -d odoo --no-http --log-level warn < "$here/docs.py"
cp "$home/docs.json" "$out/docs.json"

python3 - "$out/platform.json" "$ID" "$VERSION_ID" "$VERSION_CODENAME" "$arch" "$branch" \
  "$(git -C "$home/src" log -1 --format='%H %cs')" "$("$home/venv/bin/python" -V)" "$(runuser -u postgres -- psql -tAc 'show server_version')" <<'EOF'
import json, sys
keys = ['id', 'version', 'codename', 'arch', 'odoo', 'odoo_commit', 'python', 'postgresql']
json.dump(dict(zip(keys, sys.argv[2:])), open(sys.argv[1], 'w'), indent=2)
EOF

# engine <name> <installed: yes|no> <version> <note>
engine() {
  mkdir -p "$out/$1"
  python3 -c 'import json, sys; print(json.dumps({"engine": sys.argv[1], "installed": sys.argv[2] == "yes", "version": sys.argv[3], "note": sys.argv[4]}))' "$@" > "$out/$1/engine.json"
}

# run <name> <report.pdf_engine_default> [odoo options...]: Odoo started
# with this engine, the documents printed, Odoo stopped.
run() {
  local name="$1" param="$2"
  shift 2
  mkdir -p "$out/$name"
  chown odoo "$out/$name"
  runuser -u postgres -- psql -qtA -d odoo -c "UPDATE ir_config_parameter SET value = '$param' WHERE key = 'report.pdf_engine_default'"
  as_odoo "${odoo[@]}" server -c "$home/odoo.conf" -d odoo "$@" --logfile "$out/$name/odoo.log" &
  local pid=$!
  for _ in $(seq 120); do curl -fs -o /dev/null http://127.0.0.1:8069/web/login && break; sleep 1; done
  as_odoo "$home/venv/bin/python" -I "$here/print.py" "$home/docs.json" "$out/$name" "$name" || true
  kill "$pid"
  wait "$pid" || true
  for _ in $(seq 30); do pgrep -u odoo -f odoo-bin > /dev/null || return 0; sleep 1; done
  pkill -9 -u odoo -f odoo-bin || true
}

# fetch <url> <sha256>: into the current folder, checked.
fetch() {
  curl -fsSLO "$1"
  echo "$2  $(basename "$1")" | sha256sum -c --quiet -
}

mkdir -p /tmp/debs
cd /tmp/debs

if apt-cache show wkhtmltopdf > /dev/null 2>&1; then
  apt-get install -y -qq --no-install-recommends wkhtmltopdf > "$out/wkhtmltopdf-distro.install.log" 2>&1
  engine wkhtmltopdf-distro yes "$(wkhtmltopdf --version)" "the wkhtmltopdf package of $NAME $VERSION_ID"
  run wkhtmltopdf-distro wkhtmltopdf
  apt-get purge -y -qq --autoremove wkhtmltopdf > /dev/null
else
  engine wkhtmltopdf-distro no '' "no wkhtmltopdf package in $NAME $VERSION_ID"
fi

case "$ID-$arch" in
  debian-amd64) wk=bookworm_amd64 sum=98ba0d157b50d36f23bd0dedf4c0aa28c7b0c50fcdcdc54aa5b6bbba81a3941d ;;
  debian-arm64) wk=bookworm_arm64 sum=b6606157b27c13e044d0abbe670301f88de4e1782afca4f9c06a5817f3e03a9c ;;
  ubuntu-amd64) wk=jammy_amd64 sum=4f723b2691ad8638a9df960e0421d346d7315083e3583a334f33362280ddba15 ;;
  ubuntu-arm64) wk=jammy_arm64 sum=2095f20256661ebf0983b9311168596c9d012666e21a94bc24f304db6ac69ec5 ;;
esac
fetch "https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.$wk.deb" "$sum"
if apt-get install -y -qq --no-install-recommends "./wkhtmltox_0.12.6.1-3.$wk.deb" > "$out/wkhtmltopdf-0.12.6.install.log" 2>&1; then
  engine wkhtmltopdf-0.12.6 yes "$(wkhtmltopdf --version)" "wkhtmltox_0.12.6.1-3.$wk.deb, the official package"
  run wkhtmltopdf-0.12.6 wkhtmltopdf
  apt-get purge -y -qq --autoremove wkhtmltox > /dev/null
else
  engine wkhtmltopdf-0.12.6 no '' "wkhtmltox_0.12.6.1-3.$wk.deb does not install: $(grep -m1 -E 'Depends|E:' "$out/wkhtmltopdf-0.12.6.install.log" | sed 's/^ *//')"
fi

pm=''
case "$VERSION_CODENAME-$arch" in
  trixie-amd64) pm=94520dcddb977271d334d392958b73585b42f2b3d17817ec316fd3a36d7a7932 ;;
  noble-amd64) pm=ea7d30c3762beb47799968d7d439d0c3efc77ddff1f48bd151f9edc42faa2c9d ;;
  resolute-amd64) pm=39eaaac6c1366f308b72d6a3ebcf198383b508231422e2e5e23ab12ea62a7e7c ;;
esac
if [ -n "$pm" ]; then
  fetch "https://github.com/odoo/paper-muncher/releases/download/v0.9.0/paper-muncher_v0.9.0_${VERSION_CODENAME}_amd64.deb" "$pm"
  if apt-get install -y -qq --no-install-recommends "./paper-muncher_v0.9.0_${VERSION_CODENAME}_amd64.deb" > "$out/paper-muncher.install.log" 2>&1; then
    # The package installs under /opt; Odoo looks for paper-muncher in the PATH.
    command -v paper-muncher > /dev/null || ln -s /opt/paper-muncher/bin/paper-muncher /usr/local/bin/paper-muncher
    engine paper-muncher yes "$(paper-muncher --version 2>&1 | head -1)" "paper-muncher_v0.9.0_${VERSION_CODENAME}_amd64.deb"
    run paper-muncher paper-muncher
  else
    engine paper-muncher no '' "paper-muncher_v0.9.0_${VERSION_CODENAME}_amd64.deb does not install"
  fi
else
  engine paper-muncher no '' "no Paper Muncher v0.9.0 package for $VERSION_CODENAME $arch"
fi

if [ -n "${PDFKILN_DEB:-}" ]; then
  apt-get install -y -qq --no-install-recommends "$PDFKILN_DEB" > "$out/pdfkiln.install.log" 2>&1
  how="the Debian package built from the commit"
else
  curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc > /usr/share/keyrings/pdfkiln-archive-keyring.asc
  printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' \
    > /etc/apt/sources.list.d/pdfkiln.sources
  { apt-get update && apt-get install -y --no-install-recommends pdfkiln; } > "$out/pdfkiln.install.log" 2>&1
  how="apt install pdfkiln, from https://apt.pdfkiln.org"
fi
engine pdfkiln yes "$(wkhtmltopdf --version)" "$how; Odoo in its threaded mode"
run pdfkiln wkhtmltopdf
engine pdfkiln-workers yes "$(wkhtmltopdf --version)" "$how; Odoo with --workers 2"
run pdfkiln-workers wkhtmltopdf --workers 2

"$home/venv/bin/pip" install -q pymupdf
"$home/venv/bin/python" -I "$here/summary.py" "$out"
for name in pdfkiln pdfkiln-workers; do
  python3 -c 'import json, sys; rows = json.load(open(sys.argv[1])); sys.exit(0 if rows and all(r["pdf"] for r in rows) else 1)' "$out/$name/print.json"
done

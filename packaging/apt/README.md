# APT repository

The signed APT repository of the Debian packages, `https://apt.pdfkiln.org`:
static files in object storage, behind a CDN, no server of ours. Published
since 25 October 2026; 1.0.1 is the first version to carry
`https://apt.pdfkiln.org` in its source.

The package version is PDFKiln's and the Debian revision (`1.0.2-1`):
Chromium only changes with a new PDFKiln version, which names it in the
package's description. Up to 1.0.1, the version also carried Chromium's
(`1.0.1+chromium156.0.8078.47-1`); `1.0.2-1` is still newer for dpkg. Those
files' names hold a `+`, which the bucket reads as a space: apt encodes it,
but a direct link must write `%2B`.

```
pool/main/p/pdfkiln/pdfkiln_<version>-<revision>_<arch>.deb
dists/stable/InRelease, Release, Release.gpg
dists/stable/main/binary-{amd64,arm64}/Packages, Packages.gz
pdfkiln-archive-keyring.asc
```

- `scripts/apt.ts` adds packages to a copy of the repository, keeps the three
  newest versions per architecture, writes the index and signs it.
- `scripts/deb.ts` puts the repository's source and key in the package when
  `repository.json` exists here (`{ "url": ..., "key": "pdfkiln-archive-keyring.asc" }`),
  as Chrome's package does: installed by hand, it still gets the updates.
  The package version carries Chromium's, so that each Chromium update is an
  upgrade.
- CI (`ci.yml`, job `package`, step "APT repository with a throwaway key")
  builds a repository signed with a throwaway key, serves it on the runner,
  installs from it, upgrades, checks that a tampered index is refused and
  that purging the package removes the source.
- `.github/workflows/apt.yml` publishes the packages of two CI runs. Run by
  hand only, with "publish" typed in. CI keeps packages two days, and does
  not run on main by itself: start both runs on main first
  (`gh workflow run ci.yml --ref main`, `gh workflow run arm64.yml --ref main`),
  then `apt` with their run numbers.

## Key

The repository's key, made on 24 October 2026, is `pdfkiln-archive-keyring.asc`
here: primary `A3F7 7850 27B2 80A6 A357  3342 446E EC35 3C2D 2A2E`
(certification only, no expiry), signing subkey
`E40F 8328 2634 6795 D2BC  1506 A732 BC33 C532 88F6`, valid until
23 October 2028. Before then, the subkey's expiry is extended with the
primary key, the subkey exported again to `APT_GPG_KEY`, and the public key
committed again: packages bring it to the machines that installed them.

## Installing from the repository

```sh
curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc | sudo tee /usr/share/keyrings/pdfkiln-archive-keyring.asc > /dev/null
printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' \
  | sudo tee /etc/apt/sources.list.d/pdfkiln.sources
sudo apt update && sudo apt install pdfkiln
```

The source written by hand must be, byte for byte, the one the package
installs: it is a configuration file of the package, and dpkg asks before
replacing one it finds different. This one is 1.0.1's (checked from Debian
13 on 26 October 2026); if `repository.json` ever changes, these lines
change with the first package that carries it.

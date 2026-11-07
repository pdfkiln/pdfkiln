<p align="center">
  <img src="images/logo.svg" alt="Acme CLI" width="96">
</p>

<h1 align="center">Acme CLI</h1>

<p align="center">
  A command line for the Acme API.<br>
  <a href="#installation">Installation</a> · <a href="#usage">Usage</a> · <a href="#configuration">Configuration</a>
</p>

> [!IMPORTANT]
> Version 2 renames `acme push` to `acme deploy`. See [Upgrading](#upgrading-from-1x).

## Features

- :zap: Fast: one static binary, no runtime to install
- :lock: Secure by default: tokens stay in the system keychain
- :globe_with_meridians: Works behind proxies, with `HTTPS_PROXY`
- Plain links are linked too: https://example.com/docs

## Installation

| Platform | Command |
| --- | --- |
| macOS | `brew install acme/tap/acme` |
| Debian, Ubuntu | `sudo apt install acme` |
| Windows | `winget install Acme.CLI` |
| Any | `npm install -g @acme/cli` |

<details>
<summary>Building from source</summary>

```bash
git clone https://github.com/acme/cli.git
cd cli
make build
./bin/acme --version
```

</details>

## Usage

Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop a running command.

```console
$ acme login
Opening the browser to sign in…
Signed in as dev@example.com.
$ acme deploy --env staging
Deployed 3 services in 41 s.
```

### Commands

| Command | What it does | Since |
| :--- | :--- | ---: |
| `acme login` | Signs in, and stores the token in the keychain | 1.0 |
| `acme deploy` | Deploys the current project to an environment | 2.0 |
| `acme logs --follow` | Streams the logs of a service | 1.2 |
| `acme env list` | Lists the environments and their URLs | 1.4 |

## Configuration

The configuration lives in `acme.toml`, next to the project:

```toml
[project]
name = "shop"
region = "eu-west-3"

[deploy]
strategy = "rolling"   # or "blue-green"
timeout = 300
```

Environment variables override the file[^env].

<div style="break-before: page"></div>

## Upgrading from 1.x

1. Replace `acme push` with `acme deploy` in your scripts.
2. Remove `ACME_LEGACY=1`, which version 2 ignores.
3. Run `acme doctor`, which checks the rest.

> [!CAUTION]
> `acme deploy --force` skips the health checks. Never use it in production.

~~`acme push`~~ still works in 2.0, with a warning, and goes in 3.0.

## License

MIT. H<sub>2</sub>O and E = mc<sup>2</sup> are not part of it.

[^env]: Their names are the keys in upper case, prefixed with `ACME_`: `ACME_DEPLOY_TIMEOUT=600`.

# Grafana Slurm Job Monitor

Grafana app plugin for monitoring Slurm jobs on GPU clusters. View per-job GPU, CPU, memory, and network metrics with automatic time range and node filtering.

## Features

- **Job Search**: Search and filter Slurm jobs by user, partition, state, and name
- **Job Dashboard**: Dynamic per-job dashboards using Grafana Scenes API
  - Automatic time range (job start → end)
  - Automatic node filtering via PromQL
  - GPU metrics (DCGM exporter): utilization, memory, temperature, power, NVLink
  - CPU/Memory metrics (node_exporter): utilization, load, memory usage
  - Network metrics: NIC throughput, InfiniBand bandwidth
  - Disk I/O: read/write throughput, IOPS

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  Grafana UI │────▶│  Go Backend      │────▶│  slurmdbd   │
│  (Scenes)   │     │  (CallResource)  │     │  MariaDB    │
└──────┬──────┘     └──────────────────┘     └────────────┘
       │
       │  PromQL queries
       ▼
┌──────────────┐
│  Prometheus  │◀── DCGM exporter (GPU metrics)
│  /Victoria   │◀── node_exporter (CPU/mem/net/disk)
└──────────────┘
```

## Requirements

- Grafana >= 12.4.0
- Prometheus or VictoriaMetrics with:
  - [NVIDIA DCGM exporter](https://github.com/NVIDIA/dcgm-exporter) (port 9400)
  - [node_exporter](https://github.com/prometheus/node_exporter) (port 9100)
- slurmdbd with MariaDB/MySQL

## Development

### Prerequisites

- Node.js 24 LTS
- Go >= 1.26.1
- Docker & Docker Compose

### Setup

```bash
npm install
docker compose up -d   # Grafana + Prometheus + MariaDB (mock data)

# Terminal 1: Frontend (watch mode)
npm run dev

# Terminal 2: Backend
mage -v build:linux  # or build:darwin for macOS
```

Grafana listens on a dynamically assigned localhost port by default to avoid collisions with other projects:

```bash
docker compose port grafana 3000
```

Open the reported address in your browser and sign in with `admin/admin`.

## Install into an existing Grafana

Build and copy the plugin into Grafana's plugin directory with one command:

```bash
npm run install:grafana
```

The default destination is `/var/lib/grafana/plugins/yuuki-slurm-app`.
To install to a different directory, pass it as the first argument:

```bash
npm run install:grafana -- /path/to/grafana/plugins/yuuki-slurm-app
```

If you need to cross-build for a Linux Grafana host from another machine, set `TARGET_OS` and `TARGET_ARCH`:

```bash
TARGET_OS=linux TARGET_ARCH=amd64 npm run install:grafana
```

After installation:

1. Allow the unsigned plugin in Grafana with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=yuuki-slurm-app` (or the equivalent `grafana.ini` setting)
2. Restart Grafana
3. Navigate to **Administration → Plugins → Slurm Job Monitor → Configuration**

### Deploy to a remote Grafana over SSH

Build locally and upload the plugin to a remote Grafana host with:

```bash
DEPLOY_HOST=grafana.example.com npm run deploy:grafana:ssh
```

Common options:

```bash
DEPLOY_HOST=grafana.example.com \
DEPLOY_USER=deploy \
DEPLOY_PORT=22 \
REMOTE_PLUGIN_DIR=/var/lib/grafana/plugins/yuuki-slurm-app \
REMOTE_SUDO=1 \
RESTART_GRAFANA=1 \
TARGET_OS=linux \
TARGET_ARCH=amd64 \
npm run deploy:grafana:ssh
```

Environment variables:

1. `DEPLOY_HOST`: required remote host name or IP
2. `DEPLOY_USER`: optional SSH user
3. `DEPLOY_PORT`: optional SSH port, default `22`
4. `REMOTE_PLUGIN_DIR`: remote plugin directory, default `/var/lib/grafana/plugins/yuuki-slurm-app`
5. `REMOTE_SUDO`: set to `1` if the remote directory or restart operation requires `sudo`
6. `RESTART_GRAFANA`: set to `1` to restart Grafana after upload
7. `GRAFANA_SERVICE`: systemd service name, default `grafana-server`
8. `TARGET_OS` / `TARGET_ARCH`: target platform for the backend binary, defaults `linux/amd64`

This script expects passwordless SSH access or an agent-managed key on the machine running the command.

### Testing

```bash
# Go tests
go test ./pkg/... -v

# Frontend tests
npm test

# Type check
npm run typecheck
```

## Configuration

1. Navigate to **Administration → Plugins → Slurm Job Monitor → Configuration**
2. Set slurmdbd database connection (host, database, user, password)
3. Set cluster name (used as table prefix)
4. Set Prometheus datasource UID
5. Adjust exporter ports if non-default

## License

Apache License 2.0

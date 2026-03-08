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

Open http://localhost:3000 (admin/admin)

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

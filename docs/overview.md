# Slurm Job Monitor - User Guide

Grafana app plugin for monitoring Slurm jobs on GPU clusters. Provides per-job dashboards with GPU, CPU, memory, network, and disk metrics, all automatically scoped to the job's time range and allocated nodes.

## Features

| Feature | Description |
|---------|-------------|
| [Job Search](./job-search.md) | Search and filter Slurm jobs with an interactive timeline and table view |
| [Job Dashboard](./job-dashboard.md) | Per-job metrics dashboards with automatic time range and node filtering |
| [Metric Explorer](./metric-explorer.md) | Discover, pin, and auto-filter metrics from your monitoring stack |
| [Dashboard Export](./dashboard-export.md) | Export job dashboards as standalone Grafana dashboards |
| [Configuration](./configuration.md) | Set up database connections, cluster profiles, and access rules |

## Quick Start

1. Install the plugin into your Grafana instance
2. Navigate to **Administration > Plugins > Slurm Job Monitor > Configuration**
3. Add a database connection pointing to your slurmdbd MariaDB/MySQL
4. Add a cluster profile with your Prometheus/VictoriaMetrics datasource
5. Open **Slurm Job Monitor** from the sidebar to start searching jobs

## Requirements

- Grafana >= 12.4.0
- Prometheus or VictoriaMetrics with:
  - [NVIDIA DCGM exporter](https://github.com/NVIDIA/dcgm-exporter) for GPU metrics (default port 9400)
  - [node_exporter](https://github.com/prometheus/node_exporter) for CPU/memory/network/disk metrics (default port 9100)
- slurmdbd with MariaDB or MySQL

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  Grafana UI │────>│  Go Backend      │────>│  slurmdbd   │
│  (Scenes)   │     │  (CallResource)  │     │  MariaDB    │
└──────┬──────┘     └──────────────────┘     └────────────┘
       │
       │  PromQL queries
       v
┌──────────────┐
│  Prometheus  │<── DCGM exporter (GPU metrics)
│  /Victoria   │<── node_exporter (CPU/mem/net/disk)
└──────────────┘
```

The Go backend queries slurmdbd's MySQL database for job metadata (job ID, user, partition, nodes, GPUs, state, time range). The React frontend uses Grafana's Scenes API to build dynamic dashboards that query Prometheus/VictoriaMetrics with PromQL, automatically filtering by the job's allocated nodes and time window.

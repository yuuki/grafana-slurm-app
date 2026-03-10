#!/usr/bin/env python3
"""Generate OpenMetrics format dummy metrics for Slurm job monitoring development.

Outputs:
  dev/metrics-backfill.om  : Historical data for promtool backfill (>3h ago)
  dev/metrics-current.om   : Current snapshot for mock exporter
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dev.metrics_common import (
    JOBS, NODES, PROFILES, BACKFILL_CUTOFF, NOW, SAMPLE_INTERVAL,
    gpu_uuid, sample_value,
)

METRIC_DEFS = {
    "DCGM_FI_DEV_GPU_UTIL":            ("gauge",   "GPU utilization (in %)."),
    "DCGM_FI_DEV_FB_USED":             ("gauge",   "Framebuffer memory used (in MiB)."),
    "DCGM_FI_DEV_GPU_TEMP":            ("gauge",   "GPU temperature (in C)."),
    "DCGM_FI_DEV_POWER_USAGE":         ("gauge",   "Power draw (in W)."),
    "DCGM_FI_DEV_SM_CLOCK":            ("gauge",   "SM clock frequency (in MHz)."),
    "DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL": ("counter", "Total NVLink bandwidth (bytes)."),
    "node_cpu_seconds_total":           ("counter", "Seconds the CPUs spent in each mode."),
    "node_memory_MemTotal_bytes":       ("gauge",   "Memory information field MemTotal_bytes."),
    "node_memory_MemAvailable_bytes":   ("gauge",   "Memory information field MemAvailable_bytes."),
    "node_load15":                      ("gauge",   "15m load average."),
    "node_network_receive_bytes_total": ("counter", "Network device statistic receive_bytes."),
    "node_network_transmit_bytes_total": ("counter", "Network device statistic transmit_bytes."),
    "node_infiniband_port_data_received_bytes_total":    ("counter", "InfiniBand port data received bytes."),
    "node_infiniband_port_data_transmitted_bytes_total":  ("counter", "InfiniBand port data transmitted bytes."),
    "node_disk_read_bytes_total":       ("counter", "The total number of bytes read successfully."),
    "node_disk_written_bytes_total":    ("counter", "The total number of bytes written successfully."),
    "node_disk_reads_completed_total":  ("counter", "The total number of reads completed successfully."),
    "node_disk_writes_completed_total": ("counter", "The total number of writes completed successfully."),
}


class CounterState:
    """Track monotonically increasing counter values per label set."""

    def __init__(self):
        self._values = {}

    def advance(self, key: str, rate_per_sec: float, interval: int) -> float:
        cur = self._values.get(key, 0.0)
        cur += rate_per_sec * interval
        self._values[key] = cur
        return cur

    def get(self, key: str) -> float:
        return self._values.get(key, 0.0)


def generate_samples_for_node(node_name: str, profile: dict, ts: int,
                              counters: CounterState, interval: int) -> list:
    """Generate all metric samples for a single node at a single timestamp."""
    node = NODES[node_name]
    lines = []
    t_phase = ts  # used for sample_value oscillation

    # GPU metrics (only if node has GPUs)
    if node["gpu_count"] > 0:
        for gpu_idx in range(node["gpu_count"]):
            uuid = gpu_uuid(node_name, gpu_idx)
            dcgm_labels = (
                f'gpu="{gpu_idx}",UUID="{uuid}",'
                f'modelName="{node["gpu_model"]}",'
                f'instance="{node_name}:9400"'
            )

            gpu_util = sample_value(profile["gpu_util"], t_phase + gpu_idx * 37)
            lines.append(f'DCGM_FI_DEV_GPU_UTIL{{{dcgm_labels}}} {gpu_util:.1f} {ts}')

            fb_used = sample_value(profile["fb_used_pct"], t_phase + gpu_idx * 53) * node["fb_total"]
            lines.append(f'DCGM_FI_DEV_FB_USED{{{dcgm_labels}}} {fb_used:.0f} {ts}')

            gpu_temp = sample_value(profile["gpu_temp"], t_phase + gpu_idx * 71)
            lines.append(f'DCGM_FI_DEV_GPU_TEMP{{{dcgm_labels}}} {gpu_temp:.1f} {ts}')

            power_pct = sample_value(profile["power_pct"], t_phase + gpu_idx * 43)
            power = power_pct * node["gpu_tdp"]
            lines.append(f'DCGM_FI_DEV_POWER_USAGE{{{dcgm_labels}}} {power:.1f} {ts}')

            sm_pct = sample_value(profile["power_pct"], t_phase + gpu_idx * 61)
            sm_clock = node["sm_clock_idle"] + (node["sm_clock_max"] - node["sm_clock_idle"]) * sm_pct
            lines.append(f'DCGM_FI_DEV_SM_CLOCK{{{dcgm_labels}}} {sm_clock:.0f} {ts}')

            nvlink_rate = sample_value(profile["net_bw_pct"], t_phase + gpu_idx * 29) * 600e9 / 8
            ckey = f"nvlink:{node_name}:{gpu_idx}"
            nvlink_val = counters.advance(ckey, nvlink_rate, interval)
            lines.append(f'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL{{{dcgm_labels}}} {nvlink_val:.0f} {ts}')

    # Node-level metrics
    ne_inst = f'instance="{node_name}:9100"'

    # CPU
    cpu_util = sample_value(profile["cpu_util"], t_phase)
    idle_rate = (1.0 - cpu_util) * node["cpu_count"]
    user_rate = cpu_util * 0.7 * node["cpu_count"]
    system_rate = cpu_util * 0.3 * node["cpu_count"]
    for mode, rate in [("idle", idle_rate), ("user", user_rate), ("system", system_rate)]:
        ckey = f"cpu:{node_name}:{mode}"
        val = counters.advance(ckey, rate, interval)
        lines.append(f'node_cpu_seconds_total{{{ne_inst},mode="{mode}"}} {val:.2f} {ts}')

    # Memory
    lines.append(f'node_memory_MemTotal_bytes{{{ne_inst}}} {node["mem_total"]} {ts}')
    mem_used_pct = sample_value(profile["mem_used_pct"], t_phase + 17)
    mem_avail = int(node["mem_total"] * (1.0 - mem_used_pct))
    lines.append(f'node_memory_MemAvailable_bytes{{{ne_inst}}} {mem_avail} {ts}')

    # Load
    load15 = sample_value(profile["cpu_util"], t_phase + 23) * node["cpu_count"]
    lines.append(f'node_load15{{{ne_inst}}} {load15:.2f} {ts}')

    # Network
    net_bw = sample_value(profile["net_bw_pct"], t_phase + 31) * 12.5e9
    for direction in ["receive", "transmit"]:
        ckey = f"net:{node_name}:{direction}"
        val = counters.advance(ckey, net_bw * (1.0 if direction == "receive" else 0.8), interval)
        lines.append(f'node_network_{direction}_bytes_total{{{ne_inst},device="eth0"}} {val:.0f} {ts}')

    # InfiniBand
    ib_bw = sample_value(profile["net_bw_pct"], t_phase + 37) * 25e9
    for direction in ["received", "transmitted"]:
        ckey = f"ib:{node_name}:{direction}"
        val = counters.advance(ckey, ib_bw * (1.0 if direction == "received" else 0.9), interval)
        lines.append(
            f'node_infiniband_port_data_{direction}_bytes_total'
            f'{{{ne_inst},device="mlx5_0",port="1"}} {val:.0f} {ts}'
        )

    # Disk
    disk_bw = sample_value(profile["disk_bw_mbps"], t_phase + 41) * 1e6
    for rw, factor in [("read", 1.0), ("written", 0.6)]:
        ckey = f"disk_bytes:{node_name}:{rw}"
        val = counters.advance(ckey, disk_bw * factor, interval)
        lines.append(f'node_disk_{rw}_bytes_total{{{ne_inst},device="nvme0n1"}} {val:.0f} {ts}')

    disk_iops = sample_value((100, 50000), t_phase + 47)
    for rw, factor in [("reads", 1.0), ("writes", 0.5)]:
        ckey = f"disk_iops:{node_name}:{rw}"
        val = counters.advance(ckey, disk_iops * factor, interval)
        lines.append(f'node_disk_{rw}_completed_total{{{ne_inst},device="nvme0n1"}} {val:.0f} {ts}')

    return lines


def collect_active_nodes(jobs: list, ts: int) -> dict:
    """Return {node_name: profile_name} for all nodes active at given timestamp."""
    active = {}
    for job in jobs:
        if job["time_start"] == 0:
            continue
        start = job["time_start"]
        end = job["time_end"] if job["time_end"] > 0 else NOW + 3600
        if start <= ts <= end:
            profile_name = job["job_type"]
            for node in job["nodes"]:
                active[node] = profile_name
    return active


def write_type_headers(f):
    for name, (typ, help_text) in sorted(METRIC_DEFS.items()):
        f.write(f'# HELP {name} {help_text}\n')
        f.write(f'# TYPE {name} {typ}\n')


def generate_backfill(output_path: str):
    """Generate OpenMetrics file for historical data."""
    # Determine time range
    min_start = min((j["time_start"] for j in JOBS if j["time_start"] > 0), default=NOW)
    start_ts = min_start
    end_ts = BACKFILL_CUTOFF

    if start_ts >= end_ts:
        print(f"No backfill data needed (all jobs within last 3h)")
        with open(output_path, 'w') as f:
            f.write("# EOF\n")
        return

    print(f"Generating backfill: {start_ts} -> {end_ts} ({(end_ts - start_ts) // 3600}h)")

    counters = CounterState()
    total_samples = 0

    with open(output_path, 'w') as f:
        write_type_headers(f)

        ts = start_ts
        while ts <= end_ts:
            active = collect_active_nodes(JOBS, ts)
            for node_name, profile_name in sorted(active.items()):
                profile = PROFILES.get(profile_name, PROFILES["debug"])
                lines = generate_samples_for_node(node_name, profile, ts, counters, SAMPLE_INTERVAL)
                for line in lines:
                    f.write(line + '\n')
                total_samples += len(lines)
            ts += SAMPLE_INTERVAL

        f.write("# EOF\n")

    print(f"Backfill: {total_samples} samples written to {output_path}")
    return counters


def generate_current(output_path: str, counters: CounterState):
    """Generate current metrics snapshot for mock exporter."""
    active = collect_active_nodes(JOBS, NOW)

    with open(output_path, 'w') as f:
        write_type_headers(f)
        total = 0
        for node_name, profile_name in sorted(active.items()):
            profile = PROFILES.get(profile_name, PROFILES["debug"])
            lines = generate_samples_for_node(node_name, profile, NOW, counters, SAMPLE_INTERVAL)
            for line in lines:
                f.write(line + '\n')
            total += len(lines)
        f.write("# EOF\n")

    print(f"Current: {total} samples written to {output_path}")


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    backfill_path = os.path.join(script_dir, "metrics-backfill.om")
    current_path = os.path.join(script_dir, "metrics-current.om")

    print(f"Generating metrics for {len(JOBS)} jobs...")
    counters = generate_backfill(backfill_path)
    if counters is None:
        counters = CounterState()
    generate_current(current_path, counters)
    print("Done.")


if __name__ == "__main__":
    main()

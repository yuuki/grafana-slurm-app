#!/usr/bin/env python3
"""Mock Prometheus exporter serving current metrics for RUNNING Slurm jobs.

Listens on port 9999 and serves /metrics endpoint.
Shares job/node definitions with generate-metrics.py via metrics_common.py.
"""
import os
import sys
import time
import math
import random

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from http.server import HTTPServer, BaseHTTPRequestHandler

from dev.metrics_common import (
    RUNNING_JOBS, NODES, PROFILES, gpu_uuid, sample_value,
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

START_TIME = int(time.time())
COUNTER_BASE = START_TIME * 1000.0


def collect_active_nodes():
    active = {}
    for job in RUNNING_JOBS:
        profile_name = job["job_type"]
        for node in job["nodes"]:
            active[node] = profile_name
    return active


def generate_node_metrics(node_name, profile, now):
    node = NODES[node_name]
    lines = []
    t_phase = now
    elapsed = now - START_TIME

    if node["gpu_count"] > 0:
        for gpu_idx in range(node["gpu_count"]):
            uuid = gpu_uuid(node_name, gpu_idx)
            dcgm_labels = (
                f'gpu="{gpu_idx}",UUID="{uuid}",'
                f'modelName="{node["gpu_model"]}",'
                f'instance="{node_name}:9400"'
            )

            gpu_util = sample_value(profile["gpu_util"], t_phase + gpu_idx * 37)
            lines.append(f'DCGM_FI_DEV_GPU_UTIL{{{dcgm_labels}}} {gpu_util:.1f}')

            fb_used = sample_value(profile["fb_used_pct"], t_phase + gpu_idx * 53) * node["fb_total"]
            lines.append(f'DCGM_FI_DEV_FB_USED{{{dcgm_labels}}} {fb_used:.0f}')

            gpu_temp = sample_value(profile["gpu_temp"], t_phase + gpu_idx * 71)
            lines.append(f'DCGM_FI_DEV_GPU_TEMP{{{dcgm_labels}}} {gpu_temp:.1f}')

            power_pct = sample_value(profile["power_pct"], t_phase + gpu_idx * 43)
            power = power_pct * node["gpu_tdp"]
            lines.append(f'DCGM_FI_DEV_POWER_USAGE{{{dcgm_labels}}} {power:.1f}')

            sm_pct = sample_value(profile["power_pct"], t_phase + gpu_idx * 61)
            sm_clock = node["sm_clock_idle"] + (node["sm_clock_max"] - node["sm_clock_idle"]) * sm_pct
            lines.append(f'DCGM_FI_DEV_SM_CLOCK{{{dcgm_labels}}} {sm_clock:.0f}')

            nvlink_rate = sample_value(profile["net_bw_pct"], t_phase + gpu_idx * 29) * 600e9 / 8
            nvlink_val = COUNTER_BASE + nvlink_rate * elapsed
            lines.append(f'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL{{{dcgm_labels}}} {nvlink_val:.0f}')

    ne_inst = f'instance="{node_name}:9100"'

    cpu_util = sample_value(profile["cpu_util"], t_phase)
    idle_rate = (1.0 - cpu_util) * node["cpu_count"]
    user_rate = cpu_util * 0.7 * node["cpu_count"]
    system_rate = cpu_util * 0.3 * node["cpu_count"]
    for mode, rate in [("idle", idle_rate), ("user", user_rate), ("system", system_rate)]:
        val = COUNTER_BASE + rate * elapsed
        lines.append(f'node_cpu_seconds_total{{{ne_inst},mode="{mode}"}} {val:.2f}')

    lines.append(f'node_memory_MemTotal_bytes{{{ne_inst}}} {node["mem_total"]}')
    mem_used_pct = sample_value(profile["mem_used_pct"], t_phase + 17)
    mem_avail = int(node["mem_total"] * (1.0 - mem_used_pct))
    lines.append(f'node_memory_MemAvailable_bytes{{{ne_inst}}} {mem_avail}')

    load15 = sample_value(profile["cpu_util"], t_phase + 23) * node["cpu_count"]
    lines.append(f'node_load15{{{ne_inst}}} {load15:.2f}')

    net_bw = sample_value(profile["net_bw_pct"], t_phase + 31) * 12.5e9
    for direction in ["receive", "transmit"]:
        val = COUNTER_BASE + net_bw * (1.0 if direction == "receive" else 0.8) * elapsed
        lines.append(f'node_network_{direction}_bytes_total{{{ne_inst},device="eth0"}} {val:.0f}')

    ib_bw = sample_value(profile["net_bw_pct"], t_phase + 37) * 25e9
    for direction in ["received", "transmitted"]:
        val = COUNTER_BASE + ib_bw * (1.0 if direction == "received" else 0.9) * elapsed
        lines.append(
            f'node_infiniband_port_data_{direction}_bytes_total'
            f'{{{ne_inst},device="mlx5_0",port="1"}} {val:.0f}'
        )

    disk_bw = sample_value(profile["disk_bw_mbps"], t_phase + 41) * 1e6
    for rw, factor in [("read", 1.0), ("written", 0.6)]:
        val = COUNTER_BASE + disk_bw * factor * elapsed
        lines.append(f'node_disk_{rw}_bytes_total{{{ne_inst},device="nvme0n1"}} {val:.0f}')

    disk_iops = sample_value((100, 50000), t_phase + 47)
    for rw, factor in [("reads", 1.0), ("writes", 0.5)]:
        val = COUNTER_BASE + disk_iops * factor * elapsed
        lines.append(f'node_disk_{rw}_completed_total{{{ne_inst},device="nvme0n1"}} {val:.0f}')

    return lines


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.end_headers()

        now = int(time.time())
        active = collect_active_nodes()
        output = []

        for name, (typ, help_text) in sorted(METRIC_DEFS.items()):
            output.append(f'# HELP {name} {help_text}')
            output.append(f'# TYPE {name} {typ}')

        for node_name, profile_name in sorted(active.items()):
            profile = PROFILES.get(profile_name, PROFILES["debug"])
            output.extend(generate_node_metrics(node_name, profile, now))

        self.wfile.write(("\n".join(output) + "\n").encode())

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9999))
    server = HTTPServer(("0.0.0.0", port), MetricsHandler)
    print(f"Mock exporter listening on :{port}")
    server.serve_forever()

"""Shared constants and functions for metrics generation and mock exporter."""

import hashlib
import math
import random
import time

NOW = int(time.time())
SAMPLE_INTERVAL = 60
BACKFILL_CUTOFF = NOW - 3 * 3600

# ─── Node Definitions ────────────────────────────────────────────────────────

NODES = {}
for i in range(1, 17):
    NODES[f"gpu-node{i:03d}"] = {
        "gpu_count": 8, "gpu_model": "NVIDIA A100-SXM4-80GB",
        "mem_total": 1099511627776, "cpu_count": 128,
        "gpu_tdp": 400, "sm_clock_max": 1410, "sm_clock_idle": 210,
        "fb_total": 81920,
    }
for i in range(1, 5):
    NODES[f"h100-node{i:02d}"] = {
        "gpu_count": 8, "gpu_model": "NVIDIA H100-SXM5-80GB",
        "mem_total": 2199023255552, "cpu_count": 112,
        "gpu_tdp": 700, "sm_clock_max": 1830, "sm_clock_idle": 345,
        "fb_total": 81920,
    }
for i in range(1, 9):
    NODES[f"cpu-node{i:03d}"] = {
        "gpu_count": 0, "gpu_model": None,
        "mem_total": 549755813888, "cpu_count": 128,
        "gpu_tdp": 0, "sm_clock_max": 0, "sm_clock_idle": 0,
        "fb_total": 0,
    }

# ─── Association Definitions ─────────────────────────────────────────────────

ASSOCS = [
    {"id_assoc": 1, "user": "researcher1", "acct": "ml-team", "partition": "gpu-a100", "id_user": 1001, "id_group": 100},
    {"id_assoc": 2, "user": "researcher2", "acct": "ml-team", "partition": "gpu-a100", "id_user": 1002, "id_group": 100},
    {"id_assoc": 3, "user": "engineer1", "acct": "infra-team", "partition": "gpu-h100", "id_user": 1003, "id_group": 101},
    {"id_assoc": 4, "user": "datascientist1", "acct": "ds-team", "partition": "gpu-a100", "id_user": 1004, "id_group": 102},
    {"id_assoc": 5, "user": "intern1", "acct": "ml-team", "partition": "gpu-a100", "id_user": 1005, "id_group": 100},
    {"id_assoc": 6, "user": "researcher1", "acct": "ml-team", "partition": "gpu-h100", "id_user": 1001, "id_group": 100},
    {"id_assoc": 7, "user": "engineer1", "acct": "infra-team", "partition": "gpu-a100", "id_user": 1003, "id_group": 101},
    {"id_assoc": 8, "user": "researcher2", "acct": "ml-team", "partition": "gpu-h100", "id_user": 1002, "id_group": 100},
]

ASSOC_BY_ID = {a["id_assoc"]: a for a in ASSOCS}

# ─── Workload Profiles ───────────────────────────────────────────────────────

PROFILES = {
    "train": {
        "gpu_util": (80, 98), "fb_used_pct": (0.75, 0.95),
        "gpu_temp": (65, 80), "power_pct": (0.7, 0.95),
        "cpu_util": (0.3, 0.6), "mem_used_pct": (0.4, 0.7),
        "net_bw_pct": (0.3, 0.7), "disk_bw_mbps": (100, 500),
    },
    "finetune": {
        "gpu_util": (70, 95), "fb_used_pct": (0.5, 0.85),
        "gpu_temp": (55, 75), "power_pct": (0.5, 0.85),
        "cpu_util": (0.2, 0.5), "mem_used_pct": (0.3, 0.6),
        "net_bw_pct": (0.1, 0.4), "disk_bw_mbps": (50, 300),
    },
    "inference": {
        "gpu_util": (30, 70), "fb_used_pct": (0.3, 0.7),
        "gpu_temp": (40, 65), "power_pct": (0.3, 0.6),
        "cpu_util": (0.1, 0.3), "mem_used_pct": (0.2, 0.4),
        "net_bw_pct": (0.05, 0.2), "disk_bw_mbps": (10, 100),
    },
    "preprocess": {
        "gpu_util": (0, 10), "fb_used_pct": (0.0, 0.05),
        "gpu_temp": (30, 45), "power_pct": (0.1, 0.2),
        "cpu_util": (0.6, 0.95), "mem_used_pct": (0.5, 0.8),
        "net_bw_pct": (0.1, 0.3), "disk_bw_mbps": (500, 3000),
    },
    "benchmark": {
        "gpu_util": (90, 100), "fb_used_pct": (0.6, 0.9),
        "gpu_temp": (70, 83), "power_pct": (0.85, 1.0),
        "cpu_util": (0.4, 0.7), "mem_used_pct": (0.3, 0.5),
        "net_bw_pct": (0.5, 0.9), "disk_bw_mbps": (200, 1000),
    },
    "debug": {
        "gpu_util": (10, 50), "fb_used_pct": (0.2, 0.5),
        "gpu_temp": (35, 55), "power_pct": (0.2, 0.5),
        "cpu_util": (0.1, 0.4), "mem_used_pct": (0.2, 0.5),
        "net_bw_pct": (0.02, 0.1), "disk_bw_mbps": (10, 100),
    },
}


def gpu_uuid(node_name: str, gpu_idx: int) -> str:
    h = hashlib.md5(f"{node_name}:gpu{gpu_idx}".encode()).hexdigest()
    return f"GPU-{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def sample_value(base_range: tuple, t: float, period: float = 600, noise: float = 0.05) -> float:
    lo, hi = base_range
    mid = (lo + hi) / 2
    amp = (hi - lo) / 2
    val = mid + amp * 0.7 * math.sin(2 * math.pi * t / period)
    val += random.gauss(0, (hi - lo) * noise)
    return max(lo, min(hi, val))


def expand_nodelist(nodelist: str) -> list:
    """Expand Slurm compressed notation: gpu-node[001-008] -> list of node names."""
    if not nodelist:
        return []
    import re
    m = re.match(r'^(.+?)\[(.+)\]$', nodelist)
    if not m:
        return [nodelist]
    prefix = m.group(1)
    range_spec = m.group(2)
    nodes = []
    for part in range_spec.split(','):
        if '-' in part:
            start_s, end_s = part.split('-', 1)
            width = len(start_s)
            for i in range(int(start_s), int(end_s) + 1):
                nodes.append(f"{prefix}{i:0{width}d}")
        else:
            nodes.append(f"{prefix}{part}")
    return nodes


def _make_tres(cpus: int, mem_mb: int, node_count: int, gpus: int) -> str:
    parts = [f"1={cpus}", f"2={mem_mb}", f"4={node_count}", f"5={cpus}"]
    if gpus > 0:
        parts.append(f"1001=gres/gpu:{gpus}")
    return ",".join(parts)


def _make_nodelist(prefix: str, start: int, count: int, width: int = 3) -> str:
    if count == 1:
        return f"{prefix}{start:0{width}d}"
    return f"{prefix}[{start:0{width}d}-{start + count - 1:0{width}d}]"


def generate_jobs() -> list:
    """Generate 100 job definitions matching 02_seed.sql."""
    jobs = []
    job_id = 10001

    def add(assoc_id, name, partition, state, nodelist, nodes_alloc, gpus_per_node,
            cpus, time_start, time_end, exit_code, job_type, timelimit=1440):
        nonlocal job_id
        a = ASSOC_BY_ID[assoc_id]
        gpu_total = gpus_per_node * nodes_alloc if partition != "cpu-only" else 0
        mem_mb = cpus * 8192  # 8 GiB per CPU
        jobs.append({
            "id_job": job_id,
            "id_assoc": assoc_id,
            "id_user": a["id_user"],
            "id_group": a["id_group"],
            "job_name": name,
            "partition": partition,
            "account": a["acct"],
            "state": state,
            "nodelist": nodelist,
            "nodes_alloc": nodes_alloc,
            "cpus_req": cpus,
            "mem_req": mem_mb * 1048576,
            "time_submit": time_start - 300 if time_start > 0 else NOW - 300,
            "time_eligible": time_start - 200 if time_start > 0 else NOW - 200,
            "time_start": time_start,
            "time_end": time_end,
            "timelimit": timelimit,
            "exit_code": exit_code,
            "work_dir": f"/home/{a['user']}/experiments/{name}",
            "tres_alloc": _make_tres(cpus, mem_mb, nodes_alloc, gpu_total),
            "tres_req": _make_tres(cpus, mem_mb, nodes_alloc, gpu_total),
            "job_type": job_type,
            "nodes": expand_nodelist(nodelist),
        })
        job_id += 1

    # ── RUNNING (8) ──────────────────────────────────────────────────────
    add(1, "train_llm_70b",         "gpu-a100", 1, _make_nodelist("gpu-node", 1, 8),  8, 8, 1024, NOW-7200,  0, 0, "train", 2880)
    add(2, "finetune_bert_large",   "gpu-a100", 1, _make_nodelist("gpu-node", 9, 2),  2, 8,  256, NOW-3600,  0, 0, "finetune")
    add(6, "train_llm_13b_h100",    "gpu-h100", 1, _make_nodelist("h100-node", 1, 4, 2), 4, 8, 896, NOW-5400, 0, 0, "train", 2880)
    add(4, "inference_serving",     "gpu-a100", 1, _make_nodelist("gpu-node", 11, 1), 1, 8,  128, NOW-1800,  0, 0, "inference")
    add(1, "train_vit_huge",        "gpu-a100", 1, _make_nodelist("gpu-node", 12, 4), 4, 8,  512, NOW-14400, 0, 0, "train", 4320)
    add(3, "benchmark_nccl_h100",   "gpu-h100", 1, _make_nodelist("h100-node", 1, 2, 2), 2, 8, 224, NOW-900, 0, 0, "benchmark")
    add(5, "debug_mnist_gpu",       "gpu-a100", 1, _make_nodelist("gpu-node", 16, 1), 1, 8,  128, NOW-600,   0, 0, "debug")
    add(7, "preprocess_imagenet",   "gpu-a100", 1, _make_nodelist("gpu-node", 15, 1), 1, 0,  128, NOW-2400,  0, 0, "preprocess")

    # ── COMPLETED (55) ───────────────────────────────────────────────────
    completed_specs = [
        (1, "train_resnet50_baseline",    "gpu-a100", 4, 8, 512, 18000, "train"),
        (1, "train_llm_7b_pretrain",      "gpu-a100", 8, 8, 1024, 86400, "train"),
        (2, "train_gpt2_small",           "gpu-a100", 2, 8, 256,  7200, "train"),
        (2, "finetune_llama_lora",        "gpu-a100", 2, 8, 256,  5400, "finetune"),
        (1, "train_diffusion_model",      "gpu-a100", 4, 8, 512,  43200, "train"),
        (4, "train_tabnet_features",      "gpu-a100", 1, 8, 128,  3600, "train"),
        (4, "finetune_whisper_medium",    "gpu-a100", 2, 8, 256,  10800, "finetune"),
        (3, "benchmark_h100_gemm",        "gpu-h100", 2, 8, 224,  1800, "benchmark"),
        (3, "benchmark_h100_allreduce",   "gpu-h100", 4, 8, 448,  3600, "benchmark"),
        (6, "train_moe_expert_h100",      "gpu-h100", 4, 8, 448,  28800, "train"),
        (1, "train_clip_large",           "gpu-a100", 4, 8, 512,  21600, "train"),
        (2, "finetune_t5_summarize",      "gpu-a100", 1, 8, 128,  7200, "finetune"),
        (5, "train_mnist_baseline",       "gpu-a100", 1, 8, 128,  600, "train"),
        (5, "train_cifar10_cnn",          "gpu-a100", 1, 8, 128,  1200, "train"),
        (4, "inference_batch_scoring",    "gpu-a100", 1, 8, 128,  1800, "inference"),
        (4, "inference_model_eval",       "gpu-a100", 2, 8, 256,  2400, "inference"),
        (1, "train_wav2vec2_large",       "gpu-a100", 4, 8, 512,  36000, "train"),
        (2, "train_roberta_base",         "gpu-a100", 2, 8, 256,  14400, "train"),
        (1, "train_llm_1b_scratch",       "gpu-a100", 4, 8, 512,  57600, "train"),
        (7, "benchmark_a100_matmul",      "gpu-a100", 2, 8, 256,  1200, "benchmark"),
        (2, "finetune_stable_diff",       "gpu-a100", 4, 8, 512,  18000, "finetune"),
        (1, "train_yolo_v8_detect",       "gpu-a100", 2, 8, 256,  10800, "train"),
        (4, "eval_model_accuracy",        "gpu-a100", 1, 8, 128,  900, "inference"),
        (3, "benchmark_h100_fp8_gemm",    "gpu-h100", 1, 8, 112,  600, "benchmark"),
        (5, "debug_distributed_setup",    "gpu-a100", 2, 8, 256,  300, "debug"),
        (1, "train_llm_3b_ablation",      "gpu-a100", 2, 8, 256,  28800, "train"),
        (2, "train_vae_celeba",           "gpu-a100", 1, 8, 128,  5400, "train"),
        (4, "preprocess_text_corpus",     "gpu-a100", 1, 0, 128,  7200, "preprocess"),
        (4, "preprocess_audio_dataset",   "gpu-a100", 2, 0, 256,  10800, "preprocess"),
        (7, "preprocess_video_frames",    "gpu-a100", 1, 0, 128,  3600, "preprocess"),
        (6, "train_llm_7b_h100",          "gpu-h100", 2, 8, 224,  43200, "train"),
        (8, "finetune_code_llm_h100",     "gpu-h100", 2, 8, 224,  14400, "finetune"),
        (1, "train_seg_anything",         "gpu-a100", 8, 8, 1024, 72000, "train"),
        (2, "train_detr_coco",            "gpu-a100", 4, 8, 512,  25200, "train"),
        (1, "train_llm_13b_continued",    "gpu-a100", 8, 8, 1024, 100800, "train"),
        (5, "finetune_bert_ner",          "gpu-a100", 1, 8, 128,  2400, "finetune"),
        (4, "inference_realtime_test",    "gpu-a100", 1, 8, 128,  600, "inference"),
        (3, "benchmark_nccl_a100",        "gpu-a100", 4, 8, 512,  2400, "benchmark"),
        (2, "train_mae_pretrain",         "gpu-a100", 4, 8, 512,  36000, "train"),
        (1, "finetune_llm_chat",          "gpu-a100", 4, 8, 512,  18000, "finetune"),
        (7, "benchmark_storage_iops",     "gpu-a100", 1, 0, 128,  1800, "benchmark"),
        (4, "train_xgboost_gpu",          "gpu-a100", 1, 8, 128,  3600, "train"),
        (2, "train_stylegan3",            "gpu-a100", 2, 8, 256,  43200, "train"),
        (8, "train_multimodal_h100",      "gpu-h100", 4, 8, 448,  57600, "train"),
        (6, "benchmark_h100_transformer", "gpu-h100", 2, 8, 224,  3600, "benchmark"),
        (1, "train_llm_405b_stage1",      "gpu-a100", 16, 8, 2048, 172800, "train"),
        (5, "debug_gradient_check",       "gpu-a100", 1, 8, 128,  600, "debug"),
        (4, "preprocess_tokenize",        "gpu-a100", 1, 0, 128,  5400, "preprocess"),
        (1, "train_llm_7b_rlhf",         "gpu-a100", 4, 8, 512,  36000, "train"),
        (2, "finetune_whisper_large",     "gpu-a100", 2, 8, 256,  14400, "finetune"),
        (3, "inference_triton_bench",     "gpu-h100", 1, 8, 112,  1800, "inference"),
        (7, "preprocess_feature_eng",     "gpu-a100", 2, 0, 256,  7200, "preprocess"),
        (1, "train_dino_v2",              "gpu-a100", 4, 8, 512,  28800, "train"),
        (2, "train_nerf_scene",           "gpu-a100", 1, 8, 128,  10800, "train"),
        (4, "eval_perplexity_suite",      "gpu-a100", 2, 8, 256,  3600, "inference"),
    ]

    base_offset = 90000
    for i, (assoc_id, name, part, nodes_n, gpus_pn, cpus, duration, jtype) in enumerate(completed_specs):
        offset = base_offset + i * 5400
        if part == "gpu-a100":
            start = (i % (16 - nodes_n + 1)) + 1
            nl = _make_nodelist("gpu-node", start, nodes_n)
        elif part == "gpu-h100":
            start = (i % max(1, 4 - nodes_n + 1)) + 1
            nl = _make_nodelist("h100-node", start, nodes_n, 2)
        else:
            start = (i % max(1, 8 - nodes_n + 1)) + 1
            nl = _make_nodelist("cpu-node", start, nodes_n)
        add(assoc_id, name, part, 3, nl, nodes_n, gpus_pn, cpus,
            NOW - offset, NOW - offset + duration, 0, jtype)

    # ── FAILED (15) ──────────────────────────────────────────────────────
    failed_specs = [
        (1, "train_llm_13b_debug",     "gpu-a100", 2, 8, 256,  1200, 256, "train"),
        (2, "train_oom_experiment",     "gpu-a100", 1, 8, 128,  600,  137, "train"),
        (5, "debug_cuda_error",         "gpu-a100", 1, 8, 128,  120,  1,   "debug"),
        (4, "train_nan_loss",           "gpu-a100", 2, 8, 256,  3600, 1,   "train"),
        (1, "finetune_crashed",         "gpu-a100", 4, 8, 512,  7200, 9,   "finetune"),
        (3, "benchmark_h100_segfault",  "gpu-h100", 1, 8, 112,  300,  139, "benchmark"),
        (2, "train_dist_nccl_err",      "gpu-a100", 8, 8, 1024, 1800, 1,   "train"),
        (1, "train_checkpoint_corrupt", "gpu-a100", 4, 8, 512,  14400, 2,  "train"),
        (5, "debug_wrong_config",       "gpu-a100", 1, 8, 128,  60,   1,   "debug"),
        (4, "preprocess_disk_full",     "gpu-a100", 1, 0, 128,  900,  1,   "preprocess"),
        (8, "train_h100_driver_err",    "gpu-h100", 2, 8, 224,  300,  1,   "train"),
        (2, "finetune_lr_diverge",      "gpu-a100", 2, 8, 256,  5400, 1,   "finetune"),
        (1, "train_oom_70b_attempt",    "gpu-a100", 4, 8, 512,  900,  137, "train"),
        (7, "benchmark_network_fail",   "gpu-a100", 2, 8, 256,  600,  1,   "benchmark"),
        (4, "inference_model_missing",  "gpu-a100", 1, 8, 128,  30,   2,   "inference"),
    ]

    for i, (assoc_id, name, part, nodes_n, gpus_pn, cpus, duration, ec, jtype) in enumerate(failed_specs):
        offset = 50000 + i * 3600
        if part == "gpu-h100":
            start = (i % max(1, 4 - nodes_n + 1)) + 1
            nl = _make_nodelist("h100-node", start, nodes_n, 2)
        else:
            start = (i % max(1, 16 - nodes_n + 1)) + 1
            nl = _make_nodelist("gpu-node", start, nodes_n)
        add(assoc_id, name, part, 5, nl, nodes_n, gpus_pn, cpus,
            NOW - offset, NOW - offset + duration, ec, jtype)

    # ── PENDING (5) ──────────────────────────────────────────────────────
    pending_specs = [
        (1, "train_llm_405b_full",     "gpu-a100", 16, 8, 2048, "train"),
        (2, "train_huge_batch",        "gpu-a100", 8,  8, 1024, "train"),
        (3, "benchmark_h100_scaling",  "gpu-h100", 4,  8, 448,  "benchmark"),
        (5, "train_first_experiment",  "gpu-a100", 1,  8, 128,  "train"),
        (4, "preprocess_large_corpus", "gpu-a100", 4,  0, 512,  "preprocess"),
    ]

    for assoc_id, name, part, nodes_n, gpus_pn, cpus, jtype in pending_specs:
        add(assoc_id, name, part, 0, "", 0, gpus_pn, cpus, 0, 0, 0, jtype, 4320)

    # ── CANCELLED (8) ────────────────────────────────────────────────────
    cancelled_specs = [
        (2, "data_preprocessing_v1",   "gpu-a100", 2, 0, 256,  3600, "preprocess"),
        (1, "train_wrong_dataset",     "gpu-a100", 4, 8, 512,  1200, "train"),
        (5, "debug_cancelled_early",   "gpu-a100", 1, 8, 128,  300,  "debug"),
        (4, "finetune_wrong_params",   "gpu-a100", 2, 8, 256,  600,  "finetune"),
        (3, "benchmark_cancelled",     "gpu-h100", 2, 8, 224,  900,  "benchmark"),
        (2, "train_accidental_submit", "gpu-a100", 1, 8, 128,  60,   "train"),
        (1, "train_resource_change",   "gpu-a100", 8, 8, 1024, 1800, "train"),
        (7, "preprocess_cancelled",    "gpu-a100", 1, 0, 128,  600,  "preprocess"),
    ]

    for i, (assoc_id, name, part, nodes_n, gpus_pn, cpus, duration, jtype) in enumerate(cancelled_specs):
        offset = 200000 + i * 7200
        if part == "gpu-h100":
            start = (i % max(1, 4 - nodes_n + 1)) + 1
            nl = _make_nodelist("h100-node", start, nodes_n, 2)
        else:
            start = (i % max(1, 16 - nodes_n + 1)) + 1
            nl = _make_nodelist("gpu-node", start, nodes_n)
        add(assoc_id, name, part, 4, nl, nodes_n, gpus_pn, cpus,
            NOW - offset, NOW - offset + duration, 0, jtype)

    # ── TIMEOUT (5) ──────────────────────────────────────────────────────
    timeout_specs = [
        (1, "train_timeout_llm",       "gpu-a100", 4, 8, 512,  86400, "train"),
        (2, "finetune_timeout_bert",   "gpu-a100", 2, 8, 256,  43200, "finetune"),
        (8, "train_timeout_h100",      "gpu-h100", 2, 8, 224,  28800, "train"),
        (5, "debug_infinite_loop",     "gpu-a100", 1, 8, 128,  3600,  "debug"),
        (4, "preprocess_timeout",      "gpu-a100", 1, 0, 128,  7200,  "preprocess"),
    ]

    for i, (assoc_id, name, part, nodes_n, gpus_pn, cpus, duration, jtype) in enumerate(timeout_specs):
        offset = 300000 + i * 10000
        if part == "gpu-h100":
            start = (i % max(1, 4 - nodes_n + 1)) + 1
            nl = _make_nodelist("h100-node", start, nodes_n, 2)
        else:
            start = (i % max(1, 16 - nodes_n + 1)) + 1
            nl = _make_nodelist("gpu-node", start, nodes_n)
        add(assoc_id, name, part, 6, nl, nodes_n, gpus_pn, cpus,
            NOW - offset, NOW - offset + duration, 0, jtype, duration // 60)

    # ── NODE_FAIL (2) ────────────────────────────────────────────────────
    add(1, "train_nodefail_large",  "gpu-a100", 7, _make_nodelist("gpu-node", 1, 8), 8, 8, 1024,
        NOW - 400000, NOW - 400000 + 14400, 0, "train")
    add(3, "benchmark_nodefail_h100", "gpu-h100", 7, _make_nodelist("h100-node", 1, 4, 2), 4, 8, 448,
        NOW - 420000, NOW - 420000 + 7200, 0, "benchmark")

    # ── OOM (2) — stored as FAILED (5) + exit_code=137 ──────────────────
    add(2, "train_oom_megatron",    "gpu-a100", 5, _make_nodelist("gpu-node", 1, 4), 4, 8, 512,
        NOW - 150000, NOW - 150000 + 1800, 137, "train")
    add(1, "train_oom_deepspeed",   "gpu-a100", 5, _make_nodelist("gpu-node", 5, 8), 8, 8, 1024,
        NOW - 160000, NOW - 160000 + 3600, 137, "train")

    return jobs


JOBS = generate_jobs()
RUNNING_JOBS = [j for j in JOBS if j["state"] == 1]

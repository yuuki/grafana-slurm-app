-- Seed data for development

INSERT INTO `gpu_cluster_assoc_table` (`id_assoc`, `user`, `acct`, `partition`) VALUES
(1, 'researcher1', 'ml-team', 'gpu-a100'),
(2, 'researcher2', 'ml-team', 'gpu-a100'),
(3, 'engineer1', 'infra-team', 'gpu-h100');

INSERT INTO `gpu_cluster_job_table`
  (`id_job`, `id_assoc`, `job_name`, `partition`, `state`, `nodelist`, `nodes_alloc`, `time_start`, `time_end`, `exit_code`, `work_dir`, `tres_alloc`)
VALUES
-- Running: large distributed training job
(10001, 1, 'train_llm_70b', 'gpu-a100', 1,
 'gpu-node[001-008]', 8,
 UNIX_TIMESTAMP() - 7200, 0, 0,
 '/home/researcher1/experiments/llm-70b',
 '1=256,2=4096G,1001=gres/gpu:64'),

-- Running: medium job
(10002, 2, 'finetune_vit', 'gpu-a100', 1,
 'gpu-node[009-010]', 2,
 UNIX_TIMESTAMP() - 1800, 0, 0,
 '/home/researcher2/experiments/vit-ft',
 '1=64,2=1024G,1001=gres/gpu:16'),

-- Completed: successful job
(10003, 1, 'train_resnet50_baseline', 'gpu-a100', 3,
 'gpu-node[001-004]', 4,
 UNIX_TIMESTAMP() - 86400, UNIX_TIMESTAMP() - 72000, 0,
 '/home/researcher1/experiments/resnet50',
 '1=128,2=2048G,1001=gres/gpu:32'),

-- Failed: OOM job
(10004, 2, 'train_llm_13b_debug', 'gpu-a100', 5,
 'gpu-node[005-006]', 2,
 UNIX_TIMESTAMP() - 43200, UNIX_TIMESTAMP() - 42000, 256,
 '/home/researcher2/experiments/llm-13b-dbg',
 '1=64,2=1024G,1001=gres/gpu:16'),

-- Completed: inference benchmark
(10005, 3, 'benchmark_h100_inference', 'gpu-h100', 3,
 'h100-node[01-02]', 2,
 UNIX_TIMESTAMP() - 172800, UNIX_TIMESTAMP() - 169200, 0,
 '/home/engineer1/benchmarks/h100-infer',
 '1=128,2=2048G,1001=gres/gpu:16'),

-- Pending job
(10006, 1, 'train_llm_405b', 'gpu-a100', 0,
 '', 0,
 0, 0, 0,
 '/home/researcher1/experiments/llm-405b',
 '1=1024,2=16384G,1001=gres/gpu:256'),

-- Cancelled job
(10007, 2, 'data_preprocessing', 'gpu-a100', 4,
 'gpu-node[011-012]', 2,
 UNIX_TIMESTAMP() - 259200, UNIX_TIMESTAMP() - 258000, 0,
 '/home/researcher2/data/preprocess',
 '1=64,2=512G,1001=gres/gpu:8');

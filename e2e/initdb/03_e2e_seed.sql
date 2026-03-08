-- Additional E2E test data

INSERT INTO `gpu_cluster_assoc_table` (`id_assoc`, `user`, `acct`, `partition`) VALUES
(4, 'e2e_user1', 'test-team', 'gpu-a100');

INSERT INTO `gpu_cluster_job_table`
  (`id_job`, `id_assoc`, `job_name`, `partition`, `state`, `nodelist`, `nodes_alloc`, `time_start`, `time_end`, `exit_code`, `work_dir`, `tres_alloc`)
VALUES
-- Timeout job
(10008, 1, 'train_timeout_job', 'gpu-a100', 6,
 'gpu-node[001-002]', 2,
 UNIX_TIMESTAMP() - 172800, UNIX_TIMESTAMP() - 170000, 0,
 '/home/researcher1/experiments/timeout',
 '1=64,2=1024G,1001=gres/gpu:16'),

-- Suspended job
(10009, 2, 'suspended_analysis', 'gpu-a100', 2,
 'gpu-node[003-004]', 2,
 UNIX_TIMESTAMP() - 3600, 0, 0,
 '/home/researcher2/experiments/suspended',
 '1=64,2=1024G,1001=gres/gpu:8'),

-- Jobs for e2e_user1 (pagination and filter testing)
(10010, 4, 'e2e_train_model_a', 'gpu-a100', 3,
 'gpu-node[001-002]', 2,
 UNIX_TIMESTAMP() - 50000, UNIX_TIMESTAMP() - 48000, 0,
 '/home/e2e_user1/exp/a',
 '1=64,2=1024G,1001=gres/gpu:16'),

(10011, 4, 'e2e_train_model_b', 'gpu-a100', 3,
 'gpu-node[003-004]', 2,
 UNIX_TIMESTAMP() - 48000, UNIX_TIMESTAMP() - 46000, 0,
 '/home/e2e_user1/exp/b',
 '1=64,2=1024G,1001=gres/gpu:16'),

(10012, 4, 'e2e_train_model_c', 'gpu-a100', 1,
 'gpu-node[005-006]', 2,
 UNIX_TIMESTAMP() - 1800, 0, 0,
 '/home/e2e_user1/exp/c',
 '1=64,2=1024G,1001=gres/gpu:16');

-- Additional E2E test data (updated for full schema)

INSERT INTO `gpu_cluster_assoc_table`
  (`creation_time`, `id_assoc`, `user`, `acct`, `partition`, `parent_acct`, `id_parent`, `is_def`)
VALUES
  (UNIX_TIMESTAMP()-864000, 100, 'e2e_user1', 'test-team', 'gpu-a100', 'root', 0, 1);

INSERT INTO `gpu_cluster_job_table`
  (`id_job`, `id_assoc`, `id_user`, `id_group`, `job_name`, `partition`,
   `account`, `state`, `nodelist`, `nodes_alloc`, `cpus_req`,
   `time_submit`, `time_eligible`, `time_start`, `time_end`,
   `exit_code`, `priority`, `work_dir`, `tres_alloc`, `tres_req`)
VALUES
-- Timeout job
(20001, 1, 1001, 100, 'train_timeout_job', 'gpu-a100', 'ml-team', 6,
 'gpu-node[001-002]', 2, 64,
 UNIX_TIMESTAMP()-173100, UNIX_TIMESTAMP()-173000, UNIX_TIMESTAMP()-172800, UNIX_TIMESTAMP()-170000,
 0, 4294000000,
 '/home/researcher1/experiments/timeout',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16'),

-- Suspended job
(20002, 2, 1002, 100, 'suspended_analysis', 'gpu-a100', 'ml-team', 2,
 'gpu-node[003-004]', 2, 64,
 UNIX_TIMESTAMP()-3900, UNIX_TIMESTAMP()-3800, UNIX_TIMESTAMP()-3600, 0,
 0, 4294000000,
 '/home/researcher2/experiments/suspended',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:8',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:8'),

-- Jobs for e2e_user1 (pagination and filter testing)
(20003, 100, 10100, 100, 'e2e_train_model_a', 'gpu-a100', 'test-team', 3,
 'gpu-node[001-002]', 2, 64,
 UNIX_TIMESTAMP()-50300, UNIX_TIMESTAMP()-50200, UNIX_TIMESTAMP()-50000, UNIX_TIMESTAMP()-48000,
 0, 4294000000,
 '/home/e2e_user1/exp/a',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16'),

(20004, 100, 10100, 100, 'e2e_train_model_b', 'gpu-a100', 'test-team', 3,
 'gpu-node[003-004]', 2, 64,
 UNIX_TIMESTAMP()-48300, UNIX_TIMESTAMP()-48200, UNIX_TIMESTAMP()-48000, UNIX_TIMESTAMP()-46000,
 0, 4294000000,
 '/home/e2e_user1/exp/b',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16'),

(20005, 100, 10100, 100, 'e2e_train_model_c', 'gpu-a100', 'test-team', 1,
 'gpu-node[005-006]', 2, 64,
 UNIX_TIMESTAMP()-2100, UNIX_TIMESTAMP()-2000, UNIX_TIMESTAMP()-1800, 0,
 0, 4294000000,
 '/home/e2e_user1/exp/c',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16',
 '1=64,2=1048576,4=2,5=64,1001=gres/gpu:16');

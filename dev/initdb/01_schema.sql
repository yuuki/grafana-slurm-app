-- slurmdbd standard tables (simplified for development)

CREATE TABLE IF NOT EXISTS `gpu_cluster_assoc_table` (
  `id_assoc` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user` varchar(128) NOT NULL DEFAULT '',
  `acct` varchar(128) NOT NULL DEFAULT '',
  `partition` varchar(128) NOT NULL DEFAULT '',
  PRIMARY KEY (`id_assoc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `gpu_cluster_job_table` (
  `job_db_inx` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `id_job` int(10) unsigned NOT NULL,
  `id_assoc` int(10) unsigned NOT NULL DEFAULT 0,
  `id_user` int(10) unsigned NOT NULL DEFAULT 0,
  `job_name` varchar(256) NOT NULL DEFAULT '',
  `partition` varchar(256) NOT NULL DEFAULT '',
  `state` int(10) unsigned NOT NULL DEFAULT 0,
  `nodelist` text NOT NULL,
  `nodes_alloc` int(10) unsigned NOT NULL DEFAULT 0,
  `time_start` bigint(20) unsigned NOT NULL DEFAULT 0,
  `time_end` bigint(20) unsigned NOT NULL DEFAULT 0,
  `exit_code` int(10) unsigned NOT NULL DEFAULT 0,
  `work_dir` text NOT NULL,
  `tres_alloc` text NOT NULL,
  PRIMARY KEY (`job_db_inx`),
  UNIQUE KEY `id_job` (`id_job`),
  KEY `idx_time_start` (`time_start`),
  KEY `idx_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

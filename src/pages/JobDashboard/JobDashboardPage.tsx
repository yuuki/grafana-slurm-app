import React, { useEffect, useMemo, useState } from 'react';
import { AppPluginMeta } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder } from '@grafana/ui';
import { exportDashboard, getJob, listClusters } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import { pushRecentJob } from '../../storage/userPreferences';
import { buildJobDashboardScene } from './scenes/jobDashboardScene';

interface Props {
  meta: AppPluginMeta;
  clusterId: string;
  jobId: string;
}

export function JobDashboardPage({ meta: _meta, clusterId, jobId }: Props) {
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([listClusters(), getJob(clusterId, jobId)])
      .then(([clustersResponse, jobResponse]) => {
        if (cancelled) {
          return;
        }
        const matchingCluster = clustersResponse.clusters.find((item) => item.id === clusterId);
        if (!matchingCluster) {
          setError(`Cluster ${clusterId} not found`);
          return;
        }
        setCluster(matchingCluster);
        setJob(jobResponse);
        pushRecentJob(jobResponse);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load job');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clusterId, jobId]);

  const scene = useMemo(() => {
    if (!job || !cluster) {
      return null;
    }
    return buildJobDashboardScene(job, cluster);
  }, [cluster, job]);

  if (loading) {
    return <LoadingPlaceholder text={`Loading ${clusterId}/${jobId}...`} />;
  }

  if (error || !scene) {
    return <Alert severity="error" title={error || `Job ${clusterId}/${jobId} not found`} />;
  }

  const onExport = async () => {
    try {
      setExporting(true);
      setExportError(null);
      const result = await exportDashboard({ clusterId, jobId: Number(jobId) });
      setExportMessage(typeof result?.url === 'string' ? `Dashboard exported: ${result.url}` : 'Dashboard exported successfully.');
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Failed to export dashboard');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button onClick={onExport} disabled={exporting}>
          {exporting ? 'Exporting...' : 'Export Dashboard'}
        </Button>
      </div>
      {exportMessage && <Alert severity="success" title={exportMessage} />}
      {exportError && <Alert severity="error" title={exportError} />}
      <scene.Component model={scene} />
    </div>
  );
}

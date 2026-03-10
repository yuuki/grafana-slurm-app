import React, { useEffect, useMemo, useState } from 'react';
import { AppPluginMeta, SelectableValue } from '@grafana/data';
import { Alert, Button, Field, LoadingPlaceholder, Select } from '@grafana/ui';
import { exportDashboard, getJob, listClusters, searchGrafanaDashboards } from '../../api/slurmApi';
import { ClusterSummary, GrafanaDashboard, JobRecord } from '../../api/types';
import { pushRecentJob } from '../../storage/userPreferences';
import { buildJobDashboardScene } from './scenes/jobDashboardScene';
import { buildExternalDashboardUrl } from './scenes/model';

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
  const [grafanaDashboards, setGrafanaDashboards] = useState<GrafanaDashboard[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      listClusters(),
      getJob(clusterId, jobId),
      searchGrafanaDashboards().catch(() => []),
    ])
      .then(([clustersResponse, jobResponse, dashboards]) => {
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
        setGrafanaDashboards(dashboards);
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

  const builtinTemplateOptions: Array<SelectableValue<string>> = [
    { label: 'Overview', value: 'overview' },
    { label: 'Inference', value: 'inference' },
    { label: 'Distributed Training', value: 'distributed-training' },
  ];

  const grafanaDashboardOptions: Array<SelectableValue<string>> = grafanaDashboards.map((d) => ({
    label: d.folderTitle ? `${d.folderTitle} / ${d.title}` : d.title,
    value: `grafana:${d.uid}`,
  }));

  const templateOptions: Array<SelectableValue<string>> = [
    { label: 'Built-in Templates', value: '', options: builtinTemplateOptions },
    ...(grafanaDashboardOptions.length > 0
      ? [{ label: 'Grafana Dashboards', value: '', options: grafanaDashboardOptions }]
      : []),
  ];

  const currentTemplateValue = job?.templateId ?? 'overview';

  const handleTemplateChange = (option: SelectableValue<string>) => {
    const value = option.value;
    if (!value) {
      return;
    }

    if (value.startsWith('grafana:')) {
      const uid = value.slice('grafana:'.length);
      const dashboard = grafanaDashboards.find((d) => d.uid === uid);
      if (dashboard && job && cluster) {
        const url = buildExternalDashboardUrl(dashboard.url, job, cluster);
        window.open(url, '_blank');
      }
      return;
    }

    getJob(clusterId, jobId, value).then(setJob).catch(() => {});
  };

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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
        <Field label="Template">
          <Select
            options={templateOptions}
            value={builtinTemplateOptions.find((o) => o.value === currentTemplateValue) || builtinTemplateOptions[0]}
            onChange={handleTemplateChange}
            width={28}
            isSearchable
          />
        </Field>
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

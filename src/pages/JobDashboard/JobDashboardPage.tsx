import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { AutoFilterMetricsResponse } from '../../api/types';
import { autoFilterMetrics, exportDashboard, getJob, listClusters } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import {
  loadJobDashboardPanelSelection,
  normalizeJobDashboardPanelSelection,
  saveJobDashboardPanelSelection,
} from '../../storage/userPreferences';
import { MetricExplorer } from './components/MetricExplorer';
import { buildJobDashboardScene } from './scenes/jobDashboardScene';
import { discoverJobMetrics, MetricExplorerEntry } from './scenes/metricDiscovery';
import { collectMetricAutoFilterInput } from './scenes/metricAutoFilter';
import { getJobTimeSettings } from './scenes/model';
import { buildMetricPreviewScene, buildMetricQuery } from './scenes/metricPanelsScene';

interface Props {
  meta: AppPluginMeta;
  clusterId: string;
  jobId: string;
}

function metadataGridStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 12,
  };
}

function getStyles(theme: GrafanaTheme2) {
  return {
    metadataCard: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      padding: 12,
      background: theme.colors.background.secondary,
    }),
    textSecondary: css({
      color: theme.colors.text.secondary,
    }),
  };
}

export function JobDashboardPage({ meta: _meta, clusterId, jobId }: Props) {
  const styles = useStyles2(getStyles);
  const metricsifterServiceUrl = typeof (_meta as AppPluginMeta & { jsonData?: { metricsifterServiceUrl?: string } }).jsonData?.metricsifterServiceUrl === 'string'
    ? (_meta as AppPluginMeta & { jsonData?: { metricsifterServiceUrl?: string } }).jsonData?.metricsifterServiceUrl ?? ''
    : '';
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedMetricIds, setSelectedMetricIds] = useState<string[]>([]);
  const [rawMetricEntries, setRawMetricEntries] = useState<MetricExplorerEntry[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [autoFilterStatus, setAutoFilterStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [autoFilterError, setAutoFilterError] = useState<string | null>(null);
  const [autoFilterEnabled, setAutoFilterEnabled] = useState(false);
  const [autoFilterResult, setAutoFilterResult] = useState<AutoFilterMetricsResponse | null>(null);

  useEffect(() => {
    setSelectedMetricIds(loadJobDashboardPanelSelection(clusterId, jobId));
  }, [clusterId, jobId]);

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

  useEffect(() => {
    if (!job || !cluster) {
      return;
    }

    let cancelled = false;
    setDiscovering(true);
    setDiscoveryError(null);

    discoverJobMetrics({
      job,
      cluster,
      timeRange: getJobTimeSettings(job),
    })
      .then((entries) => {
        if (cancelled) {
          return;
        }
        setRawMetricEntries(entries);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiscoveryError(e instanceof Error ? e.message : 'Failed to discover job metrics');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDiscovering(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cluster, job]);

  useEffect(() => {
    setAutoFilterStatus('idle');
    setAutoFilterError(null);
    setAutoFilterEnabled(false);
    setAutoFilterResult(null);
  }, [clusterId, jobId, rawMetricEntries]);

  const scene = useMemo(() => {
    if (!job || !cluster || selectedMetricIds.length === 0) {
      return null;
    }
    return buildJobDashboardScene(job, cluster, selectedMetricIds);
  }, [cluster, job, selectedMetricIds]);

  if (loading) {
    return <LoadingPlaceholder text={`Loading ${clusterId}/${jobId}...`} />;
  }

  if (error) {
    return <Alert severity="error" title={error} />;
  }

  if (!job || !cluster) {
    return <Alert severity="error" title={`Job ${clusterId}/${jobId} not found`} />;
  }

  const persistSelectedMetricIds = (nextMetricIds: string[]) => {
    const normalized = normalizeJobDashboardPanelSelection(nextMetricIds);
    setSelectedMetricIds(normalized);
    saveJobDashboardPanelSelection(clusterId, jobId, normalized);
  };

  const handleToggleMetric = (metricId: string) => {
    if (selectedMetricIds.includes(metricId)) {
      persistSelectedMetricIds(selectedMetricIds.filter((id) => id !== metricId));
      return;
    }
    persistSelectedMetricIds([...selectedMetricIds, metricId]);
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

  const handleOpenInExplore = (metricKey: string) => {
    if (!job || !cluster) {
      return;
    }

    const metricQuery = buildMetricQuery(metricKey, job, cluster);
    if (!metricQuery) {
      return;
    }

    const timeSettings = getJobTimeSettings(job);
    const left = {
      datasource: { uid: cluster.metricsDatasourceUid, type: cluster.metricsType },
      queries: [
        {
          refId: 'A',
          expr: metricQuery.expr,
          legendFormat: metricQuery.legendFormat,
        },
      ],
      range: {
        from: timeSettings.from,
        to: timeSettings.to,
      },
    };

    window.open(`/explore?left=${encodeURIComponent(JSON.stringify(left))}`, '_blank', 'noopener,noreferrer');
  };

  const handleRunAutoFilter = async () => {
    if (!job || !cluster || !metricsifterServiceUrl) {
      return;
    }

    try {
      setAutoFilterStatus('loading');
      setAutoFilterError(null);
      const payload = await collectMetricAutoFilterInput({
        job,
        cluster,
        rawEntries: rawMetricEntries,
        timeRange: getJobTimeSettings(job),
      });
      const result = await autoFilterMetrics(payload);
      setAutoFilterResult(result);
      setAutoFilterEnabled(result.selectedMetricKeys.length > 0);
      setAutoFilterStatus('success');
    } catch (e) {
      setAutoFilterStatus('error');
      setAutoFilterError(e instanceof Error ? e.message : 'Failed to run auto filter');
    }
  };

  const metadata = [
    { label: 'Job ID', value: String(job.jobId) },
    { label: 'Name', value: job.name },
    { label: 'User', value: job.user },
    { label: 'Partition', value: job.partition },
    { label: 'State', value: job.state },
    { label: 'Nodes', value: String(job.nodeCount) },
    { label: 'GPUs', value: String(job.gpusTotal || '-') },
    { label: 'Pinned', value: String(selectedMetricIds.length) },
  ];

  return (
    <div>
      {exportMessage && <Alert severity="success" title={exportMessage} />}
      {exportError && <Alert severity="error" title={exportError} />}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>Job metadata</div>
            <div className={styles.textSecondary} style={{ fontSize: 13 }}>
              Summary attributes for the selected Slurm job.
            </div>
          </div>
          <Button onClick={onExport} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export Dashboard'}
          </Button>
        </div>

        <div style={metadataGridStyle()}>
          {metadata.map((item) => (
            <div key={item.label} className={styles.metadataCard}>
              <div className={styles.textSecondary} style={{ fontSize: 12, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {discovering && <LoadingPlaceholder text="Discovering job-related metrics..." />}
      {discoveryError && <Alert severity="error" title={discoveryError} />}
      {scene && <scene.Component model={scene} />}
      {!discovering && !discoveryError && (
        <div style={{ marginBottom: 16 }}>
          <MetricExplorer
            rawEntries={rawMetricEntries}
            selectedMetricKeys={selectedMetricIds}
            onTogglePin={handleToggleMetric}
            onOpenInExplore={handleOpenInExplore}
            onRunAutoFilter={handleRunAutoFilter}
            autoFilterStatus={autoFilterStatus}
            autoFilteredMetricKeys={autoFilterResult?.selectedMetricKeys ?? []}
            autoFilterEnabled={autoFilterEnabled}
            onAutoFilterEnabledChange={setAutoFilterEnabled}
            autoFilterSummary={
              autoFilterResult
                ? {
                    selectedMetricCount: autoFilterResult.selectedMetricCount,
                    totalMetricCount: autoFilterResult.totalMetricCount,
                  }
                : undefined
            }
            autoFilterError={autoFilterError}
            autoFilterDisabledReason={metricsifterServiceUrl ? null : 'MetricSifter service URL is not configured.'}
            renderPreview={(entry) => {
              const previewScene = buildMetricPreviewScene(job, cluster, entry.key);
              if (!previewScene) {
                return null;
              }
              return <previewScene.Component model={previewScene} />;
            }}
          />
        </div>
      )}
    </div>
  );
}

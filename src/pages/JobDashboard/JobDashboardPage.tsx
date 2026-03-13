import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { AutoFilterMetricsResponse, ClusterSummary, JobRecord, MetricSifterParams } from '../../api/types';
import { autoFilterMetrics, exportDashboard, getJob, listClusters } from '../../api/slurmApi';
import { formatDuration, formatTimestamp } from '../JobSearch/jobTime';
import { getJobStateTimelineColor } from '../JobSearch/jobStateStyles';
import { JsonData } from '../../components/AppConfig/types';
import { cloneMetricSifterParams } from '../../components/MetricSifter/params';
import {
  loadJobDashboardPanelSelection,
  loadMetricSifterRuntimeOverrides,
  saveMetricSifterRuntimeOverrides,
  normalizeJobDashboardPanelSelection,
  saveJobDashboardPanelSelection,
} from '../../storage/userPreferences';
import { MetricExplorer } from './components/MetricExplorer';
import { buildJobDashboardScene } from './scenes/jobDashboardScene';
import { discoverJobMetrics, MetricExplorerEntry } from './scenes/metricDiscovery';
import { collectMetricAutoFilterInput } from './scenes/metricAutoFilter';
import { getJobTimeSettings } from './scenes/model';
import { buildExploreMetricQuery, buildMetricPreviewScene, MetricDisplayMode } from './scenes/metricPanelsScene';

interface Props {
  meta: AppPluginMeta<JsonData>;
  clusterId: string;
  jobId: string;
}

export function buildAutoFilterRequestKey(input: {
  clusterId: string;
  jobId: string;
  metricKeys: string[];
  timeRange: { from: string; to: string } | null;
  params: MetricSifterParams;
}): string {
  return JSON.stringify(input);
}

export function canReuseAutoFilterResult(
  job: JobRecord | null,
  lastSuccessfulAutoFilterKey: string | null,
  autoFilterRequestKey: string,
  autoFilterResult: AutoFilterMetricsResponse | null
): boolean {
  return Boolean(job?.endTime && job.endTime > 0 && lastSuccessfulAutoFilterKey === autoFilterRequestKey && autoFilterResult);
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
    stateIndicator: css({
      display: 'inline-block',
      width: 10,
      height: 10,
      borderRadius: '50%',
      marginRight: 6,
      verticalAlign: 'middle',
    }),
    textSecondary: css({
      color: theme.colors.text.secondary,
    }),
  };
}

export function JobDashboardPage({ meta: _meta, clusterId, jobId }: Props) {
  const styles = useStyles2(getStyles);
  const metricsifterServiceUrl = typeof _meta.jsonData?.metricsifterServiceUrl === 'string' ? _meta.jsonData.metricsifterServiceUrl : '';
  const metricsifterDefaultParams = cloneMetricSifterParams(_meta.jsonData?.metricsifterDefaultParams);
  const runtimeOverrides = loadMetricSifterRuntimeOverrides(metricsifterDefaultParams);
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedMetricIds, setSelectedMetricIds] = useState<string[]>([]);
  const [displayMode, setDisplayMode] = useState<MetricDisplayMode>('aggregated');
  const [rawMetricEntries, setRawMetricEntries] = useState<MetricExplorerEntry[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [autoFilterStatus, setAutoFilterStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [autoFilterError, setAutoFilterError] = useState<string | null>(null);
  const [autoFilterEnabled, setAutoFilterEnabled] = useState(false);
  const [autoFilterResult, setAutoFilterResult] = useState<AutoFilterMetricsResponse | null>(null);
  const [lastSuccessfulAutoFilterKey, setLastSuccessfulAutoFilterKey] = useState<string | null>(null);
  const [useCustomAutoFilterSettings, setUseCustomAutoFilterSettings] = useState(runtimeOverrides.enabled);
  const [autoFilterSettings, setAutoFilterSettings] = useState<MetricSifterParams>(runtimeOverrides.params);

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
    saveMetricSifterRuntimeOverrides({
      enabled: useCustomAutoFilterSettings,
      params: autoFilterSettings,
    });
  }, [autoFilterSettings, useCustomAutoFilterSettings]);

  const selectedMetricEntries = useMemo(() => {
    const entryMap = new Map(rawMetricEntries.map((entry) => [entry.key, entry] as const));
    return selectedMetricIds.map((metricId) => entryMap.get(metricId)).filter((entry): entry is MetricExplorerEntry => entry !== undefined);
  }, [rawMetricEntries, selectedMetricIds]);
  const jobTimeSettings = useMemo(() => (job ? getJobTimeSettings(job) : null), [job]);
  const effectiveAutoFilterSettings = useMemo(
    () => (useCustomAutoFilterSettings ? autoFilterSettings : metricsifterDefaultParams),
    [autoFilterSettings, metricsifterDefaultParams, useCustomAutoFilterSettings]
  );
  const autoFilterRequestKey = useMemo(
    () =>
      buildAutoFilterRequestKey({
        clusterId,
        jobId,
        metricKeys: rawMetricEntries.map((entry) => entry.key),
        timeRange: jobTimeSettings ? { from: jobTimeSettings.from, to: jobTimeSettings.to } : null,
        params: effectiveAutoFilterSettings,
      }),
    [clusterId, effectiveAutoFilterSettings, jobId, jobTimeSettings, rawMetricEntries]
  );

  useEffect(() => {
    setAutoFilterStatus('idle');
    setAutoFilterError(null);
    setAutoFilterEnabled(false);
    setAutoFilterResult(null);
    setLastSuccessfulAutoFilterKey(null);
  }, [clusterId, jobId]);

  const scene = useMemo(() => {
    if (!job || !cluster || discovering || selectedMetricEntries.length === 0) {
      return null;
    }
    return buildJobDashboardScene(job, cluster, selectedMetricEntries, displayMode);
  }, [cluster, discovering, displayMode, job, selectedMetricEntries]);

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

    const entry = rawMetricEntries.find((item) => item.key === metricKey);
    const metricQuery = buildExploreMetricQuery(metricKey, job, cluster, displayMode, entry);
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

  const runAutoFilter = async () => {
    if (!job || !cluster || !metricsifterServiceUrl || !jobTimeSettings) {
      return;
    }

    try {
      setAutoFilterStatus('loading');
      setAutoFilterError(null);
      const payload = await collectMetricAutoFilterInput({
        job,
        cluster,
        rawEntries: rawMetricEntries,
        timeRange: jobTimeSettings,
      });
      const result = await autoFilterMetrics({
        ...payload,
        params: effectiveAutoFilterSettings,
      });
      setAutoFilterResult(result);
      setLastSuccessfulAutoFilterKey(autoFilterRequestKey);
      setAutoFilterStatus('success');
      setAutoFilterEnabled(result.selectedMetricKeys.length > 0);
    } catch (e) {
      setAutoFilterResult(null);
      setLastSuccessfulAutoFilterKey(null);
      setAutoFilterStatus('error');
      setAutoFilterError(e instanceof Error ? e.message : 'Failed to run auto filter');
      setAutoFilterEnabled(false);
    }
  };

  const handleAutoFilterEnabledChange = (enabled: boolean) => {
    if (!enabled) {
      setAutoFilterEnabled(false);
      setAutoFilterError(null);
      setAutoFilterStatus(autoFilterResult ? 'success' : 'idle');
      return;
    }

    if (autoFilterStatus === 'loading' || !metricsifterServiceUrl) {
      return;
    }

    const cachedAutoFilterResult = autoFilterResult;
    const canReuseCachedResult = canReuseAutoFilterResult(job, lastSuccessfulAutoFilterKey, autoFilterRequestKey, cachedAutoFilterResult);
    if (canReuseCachedResult && cachedAutoFilterResult) {
      setAutoFilterError(null);
      setAutoFilterStatus('success');
      setAutoFilterEnabled(cachedAutoFilterResult.selectedMetricKeys.length > 0);
      return;
    }

    void runAutoFilter();
  };

  const endEff = job.endTime > 0 ? job.endTime : Math.floor(Date.now() / 1000);
  const duration = job.startTime > 0 ? endEff - job.startTime : 0;
  const waitTime = job.startTime > 0 && job.submitTime > 0 ? job.startTime - job.submitTime : 0;

  const metadata: Array<{ label: string; value: string; color?: string }> = [
    { label: 'Job ID', value: String(job.jobId) },
    { label: 'Name', value: job.name },
    { label: 'User', value: job.user },
    { label: 'Account', value: job.account || '-' },
    { label: 'Partition', value: job.partition },
    { label: 'State', value: job.state, color: getJobStateTimelineColor(job.state) },
    { label: 'Nodes', value: String(job.nodeCount) },
    { label: 'GPUs', value: String(job.gpusTotal || '-') },
    { label: 'Submit Time', value: formatTimestamp(job.submitTime) },
    { label: 'Start Time', value: formatTimestamp(job.startTime) },
    { label: 'End Time', value: job.endTime > 0 ? formatTimestamp(job.endTime) : 'Running' },
    { label: 'Duration', value: job.startTime > 0 ? formatDuration(duration) : '-' },
    { label: 'Wait Time', value: waitTime > 0 ? formatDuration(waitTime) : '-' },
    { label: 'Exit Code', value: String(job.exitCode) },
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
              <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>
                {item.color && <span className={styles.stateIndicator} style={{ backgroundColor: item.color }} />}
                {item.value}
              </div>
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
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            onTogglePin={handleToggleMetric}
            onOpenInExplore={handleOpenInExplore}
            autoFilterStatus={autoFilterStatus}
            autoFilteredMetricKeys={autoFilterResult?.selectedMetricKeys ?? []}
            autoFilterEnabled={autoFilterEnabled}
            onAutoFilterEnabledChange={handleAutoFilterEnabledChange}
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
            defaultAutoFilterSettings={metricsifterDefaultParams}
            autoFilterSettings={autoFilterSettings}
            useCustomAutoFilterSettings={useCustomAutoFilterSettings}
            onUseCustomAutoFilterSettingsChange={setUseCustomAutoFilterSettings}
            onAutoFilterSettingsChange={setAutoFilterSettings}
            onResetAutoFilterSettings={() => setAutoFilterSettings(cloneMetricSifterParams(metricsifterDefaultParams))}
            renderPreview={(entry) => {
              const previewScene = buildMetricPreviewScene(job, cluster, entry, displayMode);
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

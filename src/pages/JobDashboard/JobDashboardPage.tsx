import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { AutoFilterMetricsResponse, ClusterSummary, FilterGranularity, JobRecord, MetricSifterParams } from '../../api/types';
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
import { buildDashboardMetricQuery, buildExploreMetricQuery, buildMetricPreviewScene, MetricDisplayMode } from './scenes/metricPanelsScene';
import { ExportDashboardModal } from './components/ExportDashboardModal';

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
  filterGranularity: FilterGranularity;
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

function getStyles(theme: GrafanaTheme2) {
  return {
    page: css({
      padding: '0 16px 16px 16px',
    }),
    metadataContainer: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 8,
      background: theme.colors.background.secondary,
      overflow: 'hidden',
    }),
    metadataRow: css({
      display: 'flex',
      flexWrap: 'wrap',
      borderBottom: `1px solid ${theme.colors.border.medium}`,
      '&:last-child': { borderBottom: 'none' },
    }),
    metadataCell: css({
      flex: '1 1 120px',
      padding: '6px 10px',
      borderRight: `1px solid ${theme.colors.border.weak}`,
      minWidth: 0,
      '&:last-child': { borderRight: 'none' },
    }),
    metadataNameRow: css({
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      padding: '6px 10px',
      borderBottom: `1px solid ${theme.colors.border.medium}`,
    }),
    metadataLabel: css({
      fontSize: 11,
      color: theme.colors.text.secondary,
      marginBottom: 2,
      whiteSpace: 'nowrap',
    }),
    metadataValue: css({
      fontSize: 13,
      fontWeight: 600,
      overflowWrap: 'anywhere',
    }),
    stateIndicator: css({
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      marginRight: 4,
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
  const filterGranularity = _meta.jsonData?.metricsifterFilterGranularity === 'aggregated' ? 'aggregated' : 'disaggregated';
  const runtimeOverrides = loadMetricSifterRuntimeOverrides(metricsifterDefaultParams);
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
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
        filterGranularity,
      }),
    [clusterId, effectiveAutoFilterSettings, filterGranularity, jobId, jobTimeSettings, rawMetricEntries]
  );

  useEffect(() => {
    setAutoFilterStatus('idle');
    setAutoFilterError(null);
    setAutoFilterEnabled(false);
    setAutoFilterResult(null);
    setLastSuccessfulAutoFilterKey(null);
  }, [clusterId, jobId]);

  const effectiveSelectedSeriesIds = useMemo(() => {
    if (filterGranularity !== 'disaggregated' || !autoFilterEnabled || !autoFilterResult?.selectedSeriesIds) {
      return undefined;
    }
    return new Set(autoFilterResult.selectedSeriesIds);
  }, [filterGranularity, autoFilterEnabled, autoFilterResult]);

  const renderPreview = useCallback(
    (entry: MetricExplorerEntry) => {
      if (!job || !cluster) {
        return null;
      }
      const previewScene = buildMetricPreviewScene(job, cluster, entry, displayMode, effectiveSelectedSeriesIds);
      if (!previewScene) {
        return null;
      }
      return <previewScene.Component model={previewScene} />;
    },
    [job, cluster, displayMode, effectiveSelectedSeriesIds]
  );

  const scene = useMemo(() => {
    if (!job || !cluster || discovering || selectedMetricEntries.length === 0) {
      return null;
    }
    return buildJobDashboardScene(job, cluster, selectedMetricEntries, displayMode, effectiveSelectedSeriesIds);
  }, [cluster, discovering, displayMode, effectiveSelectedSeriesIds, job, selectedMetricEntries]);

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

  const onExport = async (folderUid?: string) => {
    try {
      setExporting(true);
      setExportError(null);
      setExportModalOpen(false);
      const panels: Array<{ title: string; expr: string; legendFormat: string; unit: string }> = [];
      for (const entry of selectedMetricEntries) {
        const q = buildDashboardMetricQuery(entry, displayMode, job!, cluster!);
        if (q) {
          panels.push({ title: q.title, expr: q.expr, legendFormat: q.legendFormat, unit: q.fieldConfig.defaults.unit ?? '' });
        }
      }
      const result = await exportDashboard({
        clusterId,
        jobId: Number(jobId),
        folderUid: folderUid || undefined,
        panels,
      });
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
        filterGranularity,
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

  const identityFields: Array<{ label: string; value: string; color?: string }> = [
    { label: 'Job ID', value: String(job.jobId) },
    { label: 'User', value: job.user },
    { label: 'Account', value: job.account || '-' },
    { label: 'Partition', value: job.partition },
    { label: 'State', value: job.state, color: getJobStateTimelineColor(job.state) },
    { label: 'Nodes', value: String(job.nodeCount) },
    { label: 'GPUs', value: String(job.gpusTotal || '-') },
  ];

  const timingFields: Array<{ label: string; value: string }> = [
    { label: 'Submit', value: formatTimestamp(job.submitTime) },
    { label: 'Start', value: formatTimestamp(job.startTime) },
    { label: 'End', value: job.endTime > 0 ? formatTimestamp(job.endTime) : 'Running' },
    { label: 'Duration', value: job.startTime > 0 ? formatDuration(duration) : '-' },
    { label: 'Wait', value: waitTime > 0 ? formatDuration(waitTime) : '-' },
    { label: 'Exit Code', value: String(job.exitCode) },
  ];

  return (
    <div className={styles.page}>
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
          <Button
            onClick={() => setExportModalOpen(true)}
            disabled={exporting || selectedMetricEntries.length === 0}
            tooltip={selectedMetricEntries.length === 0 ? 'Pin at least one metric to export' : undefined}
          >
            {exporting ? 'Exporting...' : 'Export Dashboard'}
          </Button>
        </div>

        <div className={styles.metadataContainer}>
          <div className={styles.metadataRow}>
            {identityFields.map((item) => (
              <div key={item.label} className={styles.metadataCell}>
                <div className={styles.metadataLabel}>{item.label}</div>
                <div className={styles.metadataValue}>
                  {item.color && <span className={styles.stateIndicator} style={{ backgroundColor: item.color }} />}
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          <div className={styles.metadataNameRow}>
            <div className={styles.metadataLabel}>Name</div>
            <div className={styles.metadataValue}>{job.name || '-'}</div>
          </div>
          <div className={styles.metadataRow}>
            {timingFields.map((item) => (
              <div key={item.label} className={styles.metadataCell}>
                <div className={styles.metadataLabel}>{item.label}</div>
                <div className={styles.metadataValue}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ExportDashboardModal
        isOpen={exportModalOpen}
        defaultFolderUid={_meta.jsonData?.defaultExportFolderUid}
        onConfirm={onExport}
        onDismiss={() => setExportModalOpen(false)}
        exporting={exporting}
      />

      {discovering && <LoadingPlaceholder text="Discovering job-related metrics..." />}
      {discoveryError && <Alert severity="error" title={discoveryError} />}
      {scene && (
        <div style={{ flex: 'none', minHeight: 0 }}>
          <scene.Component model={scene} />
        </div>
      )}
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
                    selectedSeriesCount: autoFilterResult.selectedSeriesCount,
                    totalSeriesCount: autoFilterResult.totalSeriesCount,
                    filterGranularity,
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
            renderPreview={renderPreview}
          />
        </div>
      )}
    </div>
  );
}

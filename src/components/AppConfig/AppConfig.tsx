import React, { useEffect, useMemo, useState } from 'react';
import { AppPluginMeta, PluginConfigPageProps, SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, Input, Select } from '@grafana/ui';
import type { FilterGranularity } from '../../api/types';
import { loadFolderOptions } from '../../api/slurmApi';
import { ClusterProfile, ConnectionFormState, JsonData } from './types';
import { newConnection, newCluster } from './defaults';
import { ConnectionEditor } from './ConnectionEditor';
import { ClusterEditor } from './ClusterEditor';
import { MetricSifterParamsEditor } from '../MetricSifter/MetricSifterParamsEditor';
import { cloneMetricSifterParams } from '../MetricSifter/params';

const filterGranularityOptions: Array<SelectableValue<FilterGranularity>> = [
  { label: 'Disaggregated (default)', value: 'disaggregated' },
  { label: 'Aggregated', value: 'aggregated' },
];

interface Props extends PluginConfigPageProps<AppPluginMeta<JsonData>> {}

function normalizeClusterProfile(cluster: ClusterProfile): ClusterProfile {
  return {
    id: cluster.id,
    displayName: cluster.displayName,
    connectionId: cluster.connectionId,
    slurmClusterName: cluster.slurmClusterName,
    metricsDatasourceUid: cluster.metricsDatasourceUid,
    metricsType: cluster.metricsType,
    aggregationNodeLabels: cluster.aggregationNodeLabels,
    instanceLabel: cluster.instanceLabel,
    nodeMatcherMode: cluster.nodeMatcherMode,
    defaultTemplateId: cluster.defaultTemplateId,
    metricsFilterLabel: cluster.metricsFilterLabel,
    metricsFilterValue: cluster.metricsFilterValue,
    accessRule: cluster.accessRule,
  };
}

export function AppConfig({ plugin }: Props) {
  const { jsonData, secureJsonFields } = plugin.meta;

  const initialConnections = useMemo<ConnectionFormState[]>(() => {
    if (jsonData?.connections && jsonData.connections.length > 0) {
      return jsonData.connections.map((c) => ({
        ...c,
        password: '',
        isPasswordConfigured: !!(secureJsonFields as Record<string, boolean>)?.[c.securePasswordRef],
      }));
    }

    if (jsonData?.dbHost) {
      return [
        {
          id: 'default',
          dbHost: jsonData.dbHost,
          dbName: jsonData.dbName || 'slurm_acct_db',
          dbUser: jsonData.dbUser || 'slurm',
          securePasswordRef: 'dbPassword',
          password: '',
          isPasswordConfigured: !!(secureJsonFields as Record<string, boolean>)?.['dbPassword'],
        },
      ];
    }

    return [
      {
        id: 'default',
        dbHost: 'mysql:3306',
        dbName: 'slurm_acct_db',
        dbUser: 'slurm',
        securePasswordRef: 'dbPassword',
        password: '',
        isPasswordConfigured: false,
      },
    ];
  }, [jsonData, secureJsonFields]);

  const initialClusters = useMemo<ClusterProfile[]>(() => {
    if (jsonData?.clusters && jsonData.clusters.length > 0) {
      return jsonData.clusters.map(normalizeClusterProfile);
    }

    if (jsonData?.clusterName) {
      return [
        normalizeClusterProfile({
          id: jsonData.clusterName,
          displayName: jsonData.clusterName,
          connectionId: 'default',
          slurmClusterName: jsonData.clusterName,
          metricsDatasourceUid: jsonData.promDatasourceUid || 'prometheus',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', jsonData.instanceLabel || 'instance'],
          instanceLabel: jsonData.instanceLabel || 'instance',
          nodeMatcherMode: 'host:port',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
          accessRule: { allowedRoles: ['Viewer', 'Editor', 'Admin'] },
        }),
      ];
    }

    return [
      normalizeClusterProfile({
        id: 'gpu_cluster',
        displayName: 'gpu_cluster',
        connectionId: 'default',
        slurmClusterName: 'gpu_cluster',
        metricsDatasourceUid: 'prometheus',
        metricsType: 'prometheus',
        aggregationNodeLabels: ['host.name', 'instance'],
        instanceLabel: 'instance',
        nodeMatcherMode: 'host:port',
        defaultTemplateId: 'overview',
        metricsFilterLabel: '',
        metricsFilterValue: '',
        accessRule: { allowedRoles: ['Viewer', 'Editor', 'Admin'] },
      }),
    ];
  }, [jsonData]);

  const [connections, setConnections] = useState<ConnectionFormState[]>(initialConnections);
  const [clusters, setClusters] = useState<ClusterProfile[]>(initialClusters);
  const [metricsifterServiceUrl, setMetricsifterServiceUrl] = useState(jsonData?.metricsifterServiceUrl || '');
  const [metricsifterFilterGranularity, setMetricsifterFilterGranularity] = useState<FilterGranularity>(jsonData?.metricsifterFilterGranularity ?? 'disaggregated');
  const [metricsifterDefaultParams, setMetricsifterDefaultParams] = useState(() => cloneMetricSifterParams(jsonData?.metricsifterDefaultParams));
  const [defaultExportFolderUid, setDefaultExportFolderUid] = useState(jsonData?.defaultExportFolderUid || '');
  const [folderOptions, setFolderOptions] = useState<Array<SelectableValue<string>>>([{ label: 'General', value: '' }]);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    loadFolderOptions()
      .then(setFolderOptions)
      .catch(() => {});
  }, []);

  const connectionOptions: Array<SelectableValue<string>> = connections.map((c) => ({
    label: `${c.id}${c.dbHost ? ` (${c.dbHost})` : ''}`,
    value: c.id,
  }));

  const handleConnectionChange = (index: number) => (updated: ConnectionFormState) => {
    setConnections((prev) => prev.map((c, i) => (i === index ? updated : c)));
  };

  const handleConnectionDelete = (index: number) => () => {
    setConnections((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClusterChange = (index: number) => (updated: ClusterProfile) => {
    setClusters((prev) => prev.map((c, i) => (i === index ? updated : c)));
  };

  const handleClusterDelete = (index: number) => () => {
    setClusters((prev) => prev.filter((_, i) => i !== index));
  };

  const onSave = async () => {
    setSaving(true);
    setSaveResult(null);

    const validationErrors: string[] = [];
    const connectionIds = new Set(connections.map((c) => c.id));

    for (const conn of connections) {
      if (!conn.dbHost?.trim()) {
        validationErrors.push(`Connection "${conn.id}": DB Host is required`);
      }
      if (!conn.dbUser?.trim()) {
        validationErrors.push(`Connection "${conn.id}": DB User is required`);
      }
      if (!conn.isPasswordConfigured && !conn.password?.trim()) {
        validationErrors.push(`Connection "${conn.id}": Password is required`);
      }
    }

    for (const cluster of clusters) {
      if (!cluster.slurmClusterName?.trim()) {
        validationErrors.push(`Cluster "${cluster.id}": Slurm Cluster Name is required`);
      }
      if (!cluster.connectionId?.trim()) {
        validationErrors.push(`Cluster "${cluster.id}": Connection is required`);
      } else if (!connectionIds.has(cluster.connectionId)) {
        validationErrors.push(`Cluster "${cluster.id}": Connection "${cluster.connectionId}" does not exist`);
      }
      if (!cluster.metricsDatasourceUid?.trim()) {
        validationErrors.push(`Cluster "${cluster.id}": Metrics Datasource UID is required`);
      }
    }

    if (validationErrors.length > 0) {
      setSaveResult({
        success: false,
        message: `Please fix the following errors before saving: ${validationErrors.join('; ')}`,
      });
      setSaving(false);
      return;
    }

    try {
      const secureJsonData: Record<string, string> = {};
      const savedConnections = connections.map((conn) => {
        if (conn.password) {
          secureJsonData[conn.securePasswordRef] = conn.password;
        } else if (!conn.isPasswordConfigured) {
          // Explicitly send empty string to clear a previously configured password
          secureJsonData[conn.securePasswordRef] = '';
        }
        return {
          id: conn.id,
          dbHost: conn.dbHost,
          dbName: conn.dbName,
          dbUser: conn.dbUser,
          securePasswordRef: conn.securePasswordRef,
        };
      });
      const savedClusters = clusters.map(normalizeClusterProfile);

      await getBackendSrv().post(`/api/plugins/${plugin.meta.id}/settings`, {
        enabled: true,
        pinned: true,
        jsonData: {
          connections: savedConnections,
          clusters: savedClusters,
          metricsifterServiceUrl,
          metricsifterFilterGranularity,
          metricsifterDefaultParams,
          defaultExportFolderUid: defaultExportFolderUid || undefined,
        },
        secureJsonData,
      });
      setSaveResult({ success: true, message: 'Settings saved successfully.' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      setSaveResult({ success: false, message: `Failed to save settings: ${message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {saveResult && <Alert severity={saveResult.success ? 'success' : 'error'} title={saveResult.message} />}

      <FieldSet label="Connection Profiles">
        {connections.map((conn, i) => (
          <ConnectionEditor
            key={conn.id}
            connection={conn}
            onChange={handleConnectionChange(i)}
            onDelete={handleConnectionDelete(i)}
          />
        ))}
        <Button variant="secondary" icon="plus" onClick={() => setConnections((prev) => [...prev, newConnection()])}>
          Add Connection
        </Button>
      </FieldSet>

      <FieldSet label="Cluster Profiles">
        {clusters.map((cluster, i) => (
          <ClusterEditor
            key={cluster.id}
            cluster={cluster}
            connectionOptions={connectionOptions}
            onChange={handleClusterChange(i)}
            onDelete={handleClusterDelete(i)}
          />
        ))}
        <Button
          variant="secondary"
          icon="plus"
          disabled={connections.length === 0}
          onClick={() => setClusters((prev) => [...prev, newCluster(connections[0].id)])}
        >
          Add Cluster
        </Button>
      </FieldSet>

      <FieldSet label="Auto Filter">
        <Field label="MetricSifter Service URL" description="Internal HTTP endpoint for the MetricSifter sidecar.">
          <Input
            value={metricsifterServiceUrl}
            onChange={(event) => setMetricsifterServiceUrl(event.currentTarget.value)}
            placeholder="http://metricsifter:8000"
          />
        </Field>
        <Field label="Filter granularity" description="Controls whether MetricSifter filters at disaggregated (per-series) or aggregated (per-metric) level.">
          <Select
            aria-label="Filter granularity"
            options={filterGranularityOptions}
            value={filterGranularityOptions.find((o) => o.value === metricsifterFilterGranularity)}
            onChange={(v: SelectableValue<FilterGranularity>) => setMetricsifterFilterGranularity(v.value ?? 'disaggregated')}
          />
        </Field>
        <MetricSifterParamsEditor
          idPrefix="app-config-metricsifter"
          params={metricsifterDefaultParams}
          onChange={setMetricsifterDefaultParams}
        />
      </FieldSet>

      <FieldSet label="Dashboard Export">
        <Field label="Default Export Folder" description="Default Grafana folder for exported dashboards. Users can override this when exporting.">
          <Select
            aria-label="Default export folder"
            options={folderOptions}
            value={folderOptions.find((o) => o.value === defaultExportFolderUid)}
            onChange={(v: SelectableValue<string>) => setDefaultExportFolderUid(v.value ?? '')}
          />
        </Field>
      </FieldSet>

      <Button onClick={onSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </Button>
    </div>
  );
}

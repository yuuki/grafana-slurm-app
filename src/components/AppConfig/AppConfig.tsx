import React, { useMemo, useState } from 'react';
import { AppPluginMeta, PluginConfigPageProps, SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, FieldSet } from '@grafana/ui';
import { ClusterProfile, ConnectionFormState, JsonData } from './types';
import { newConnection, newCluster } from './defaults';
import { ConnectionEditor } from './ConnectionEditor';
import { ClusterEditor } from './ClusterEditor';

interface Props extends PluginConfigPageProps<AppPluginMeta<JsonData>> {}

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
      return jsonData.clusters;
    }

    if (jsonData?.clusterName) {
      return [
        {
          id: jsonData.clusterName,
          displayName: jsonData.clusterName,
          connectionId: 'default',
          slurmClusterName: jsonData.clusterName,
          metricsDatasourceUid: jsonData.promDatasourceUid || 'prometheus',
          metricsType: 'prometheus',
          instanceLabel: jsonData.instanceLabel || 'instance',
          nodeExporterPort: jsonData.nodeExporterPort || '9100',
          dcgmExporterPort: jsonData.dcgmExporterPort || '9400',
          nodeMatcherMode: 'host:port',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
          accessRule: { allowedRoles: ['Viewer', 'Editor', 'Admin'] },
        },
      ];
    }

    return [
      {
        id: 'gpu_cluster',
        displayName: 'gpu_cluster',
        connectionId: 'default',
        slurmClusterName: 'gpu_cluster',
        metricsDatasourceUid: 'prometheus',
        metricsType: 'prometheus',
        instanceLabel: 'instance',
        nodeExporterPort: '9100',
        dcgmExporterPort: '9400',
        nodeMatcherMode: 'host:port',
        defaultTemplateId: 'overview',
        metricsFilterLabel: '',
        metricsFilterValue: '',
        accessRule: { allowedRoles: ['Viewer', 'Editor', 'Admin'] },
      },
    ];
  }, [jsonData]);

  const [connections, setConnections] = useState<ConnectionFormState[]>(initialConnections);
  const [clusters, setClusters] = useState<ClusterProfile[]>(initialClusters);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

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

      await getBackendSrv().post(`/api/plugins/${plugin.meta.id}/settings`, {
        enabled: true,
        pinned: true,
        jsonData: {
          connections: savedConnections,
          clusters,
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

      <Button onClick={onSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </Button>
    </div>
  );
}

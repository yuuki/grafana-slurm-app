import React, { ChangeEvent, useMemo, useState } from 'react';
import { AppPluginMeta, PluginConfigPageProps } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, TextArea } from '@grafana/ui';

type ConnectionProfile = {
  id: string;
  dbHost: string;
  dbName?: string;
  dbUser: string;
  securePasswordRef: string;
};

type ClusterProfile = {
  id: string;
  displayName: string;
  connectionId: string;
  slurmClusterName: string;
  metricsDatasourceUid: string;
  metricsType?: 'prometheus' | 'victoriametrics';
  instanceLabel?: string;
  nodeExporterPort?: string;
  dcgmExporterPort?: string;
  nodeMatcherMode?: 'host:port' | 'hostname';
  defaultTemplateId?: string;
  accessRule?: {
    allowedRoles?: string[];
    allowedUsers?: string[];
  };
};

type JsonData = {
  connections?: ConnectionProfile[];
  clusters?: ClusterProfile[];
  dbHost?: string;
  dbName?: string;
  dbUser?: string;
  clusterName?: string;
  promDatasourceUid?: string;
  nodeExporterPort?: string;
  dcgmExporterPort?: string;
  instanceLabel?: string;
};

interface Props extends PluginConfigPageProps<AppPluginMeta<JsonData>> {}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function AppConfig({ plugin }: Props) {
  const { jsonData, secureJsonFields } = plugin.meta;
  const initialConnections = useMemo<ConnectionProfile[]>(
    () => {
      if (jsonData?.connections && jsonData.connections.length > 0) {
        return jsonData.connections;
      }

      if (jsonData?.dbHost) {
        return [
          {
            id: 'default',
            dbHost: jsonData.dbHost,
            dbName: jsonData.dbName || 'slurm_acct_db',
            dbUser: jsonData.dbUser || 'slurm',
            securePasswordRef: 'dbPassword',
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
        },
      ];
    },
    [jsonData?.connections, jsonData?.dbHost, jsonData?.dbName, jsonData?.dbUser]
  );
  const initialClusters = useMemo<ClusterProfile[]>(
    () => {
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
            accessRule: {
              allowedRoles: ['Viewer', 'Editor', 'Admin'],
            },
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
          accessRule: {
            allowedRoles: ['Viewer', 'Editor', 'Admin'],
          },
        },
      ];
    },
    [
      jsonData?.clusterName,
      jsonData?.clusters,
      jsonData?.dcgmExporterPort,
      jsonData?.instanceLabel,
      jsonData?.nodeExporterPort,
      jsonData?.promDatasourceUid,
    ]
  );

  const [connectionsText, setConnectionsText] = useState(pretty(initialConnections));
  const [clustersText, setClustersText] = useState(pretty(initialClusters));
  const [passwordsText, setPasswordsText] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  const onChange = (setter: (value: string) => void) => (event: ChangeEvent<HTMLTextAreaElement>) => {
    setter(event.currentTarget.value);
  };

  const onSave = async () => {
    setSaving(true);
    setSaveResult(null);

    try {
      const connections = JSON.parse(connectionsText) as ConnectionProfile[];
      const clusters = JSON.parse(clustersText) as ClusterProfile[];
      const secureJsonData = JSON.parse(passwordsText) as Record<string, string>;

      await getBackendSrv().post(`/api/plugins/${plugin.meta.id}/settings`, {
        enabled: true,
        pinned: true,
        jsonData: {
          connections,
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
        <Field
          label="Connections JSON"
          description="Array of slurmdbd connection profiles. Password values live in the secure JSON object and are referenced by securePasswordRef."
        >
          <TextArea rows={14} value={connectionsText} onChange={onChange(setConnectionsText)} />
        </Field>
      </FieldSet>

      <FieldSet label="Cluster Profiles">
        <Field
          label="Clusters JSON"
          description="Array of cluster profiles. Each cluster references a connectionId and defines metrics datasource, matcher mode, default template, and access rules."
        >
          <TextArea rows={18} value={clustersText} onChange={onChange(setClustersText)} />
        </Field>
      </FieldSet>

      <FieldSet label="Secure Password Map">
        <Field
          label="Passwords JSON"
          description={`JSON object of password refs to plain values for this save only. Existing configured refs: ${Object.keys(secureJsonFields || {}).join(', ') || 'none'}`}
        >
          <TextArea rows={8} value={passwordsText} onChange={onChange(setPasswordsText)} />
        </Field>
      </FieldSet>

      <Button onClick={onSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </Button>
    </div>
  );
}

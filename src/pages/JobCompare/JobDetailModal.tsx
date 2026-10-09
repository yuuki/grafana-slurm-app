import React, { useMemo } from 'react';
import { Button, LinkButton, Modal } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildJobRoute } from '../../constants';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { buildMetricPreviewScene } from '../JobDashboard/scenes/metricPanelsScene';
import { buildCompareMetricEntry } from './metricCatalog';

interface Props {
  job: JobRecord;
  cluster: ClusterSummary;
  metricName: string;
  metricType: PrometheusMetricType;
  onDismiss: () => void;
}

export function JobDetailModal({ job, cluster, metricName, metricType, onDismiss }: Props) {
  const scene = useMemo(
    () => buildMetricPreviewScene(job, cluster, buildCompareMetricEntry(metricName, metricType), 'raw'),
    [job, cluster, metricName, metricType]
  );

  return (
    <Modal title={`#${job.jobId} ${job.name} · ${metricName}`} isOpen onDismiss={onDismiss}>
      {scene ? <scene.Component model={scene} /> : <div>No query is available for this metric.</div>}
      <Modal.ButtonRow>
        <LinkButton href={buildJobRoute(job.clusterId, job.jobId)} variant="secondary" icon="external-link-alt">
          Open job dashboard
        </LinkButton>
        <Button variant="primary" onClick={onDismiss}>
          Done
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}

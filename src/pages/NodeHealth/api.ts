import { getBackendSrv } from '@grafana/runtime';
import { PLUGIN_ID } from '../../constants';
import { NodeHealthPayload } from './types';

const BASE_URL = `/api/plugins/${PLUGIN_ID}/resources`;

export async function getNodeHealth(clusterId: string, from: number, to: number): Promise<NodeHealthPayload> {
  const params = new URLSearchParams({
    clusterId,
    from: String(from),
    to: String(to),
  });
  return getBackendSrv().get(`${BASE_URL}/api/nodes/health?${params.toString()}`);
}

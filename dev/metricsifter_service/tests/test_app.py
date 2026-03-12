from fastapi.testclient import TestClient

from app import app


def test_filter_returns_selected_metric_keys(monkeypatch):
    class FakeSegment:
        start_time = 0
        end_time = 1

    class FakeFrame:
        columns = ["node:node_load15:instance=gpu-node001:9100"]

    class FakeSifter:
        def run_with_selected_segment(self, data, without_simple_filter=False):
            assert list(data.columns) == ["node:node_load15:instance=gpu-node001:9100", "gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400"]
            return FakeFrame(), FakeSegment()

    monkeypatch.setattr("app.Sifter", FakeSifter)

    client = TestClient(app)
    response = client.post(
        "/v1/filter",
        json={
            "clusterId": "a100",
            "jobId": "10001",
            "timestamps": [1700000000000, 1700000060000],
            "series": [
                {
                    "seriesId": "node:node_load15:instance=gpu-node001:9100",
                    "metricKey": "raw:node:node_load15",
                    "metricName": "node_load15",
                    "values": [1.5, 2.5],
                },
                {
                    "seriesId": "gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400",
                    "metricKey": "raw:gpu:DCGM_FI_DEV_GPU_UTIL",
                    "metricName": "DCGM_FI_DEV_GPU_UTIL",
                    "values": [20, 40],
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "selectedMetricKeys": ["raw:node:node_load15"],
        "selectedSeriesCount": 1,
        "totalSeriesCount": 2,
        "selectedMetricCount": 1,
        "totalMetricCount": 2,
        "selectedWindow": {
            "fromMs": 1700000000000,
            "toMs": 1700000060000,
        },
    }


def test_filter_returns_empty_selection_when_no_series_survive(monkeypatch):
    class FakeSifter:
        def run_with_selected_segment(self, data, without_simple_filter=False):
            return data.iloc[:, 0:0], None

    monkeypatch.setattr("app.Sifter", FakeSifter)

    client = TestClient(app)
    response = client.post(
        "/v1/filter",
        json={
            "clusterId": "a100",
            "jobId": "10001",
            "timestamps": [1700000000000],
            "series": [
                {
                    "seriesId": "node:node_load15:instance=gpu-node001:9100",
                    "metricKey": "raw:node:node_load15",
                    "metricName": "node_load15",
                    "values": [1.5],
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["selectedMetricKeys"] == []

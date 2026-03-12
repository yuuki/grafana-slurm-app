from fastapi.testclient import TestClient

from app import app


def test_filter_returns_selected_metric_keys(monkeypatch):
    class FakeSegment:
        start_time = 0
        end_time = 1

    class FakeFrame:
        columns = ["node:node_load15:instance=gpu-node001:9100"]

    class FakeSifter:
        def __init__(self, **kwargs):
            pass

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
        def __init__(self, **kwargs):
            pass

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


def test_filter_passes_hyper_parameters_to_sifter(monkeypatch):
    captured = {}

    class FakeSifter:
        def __init__(self, **kwargs):
            captured["init"] = kwargs

        def run_with_selected_segment(self, data, without_simple_filter=False):
            captured["without_simple_filter"] = without_simple_filter
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
            "params": {
                "searchMethod": "bottomup",
                "costModel": "rbf",
                "penalty": 8.0,
                "penaltyAdjust": 3.0,
                "bandwidth": 4.5,
                "segmentSelectionMethod": "max",
                "nJobs": -1,
                "withoutSimpleFilter": True,
            },
        },
    )

    assert response.status_code == 200
    assert captured["init"] == {
        "search_method": "bottomup",
        "cost_model": "rbf",
        "penalty": 8.0,
        "penalty_adjust": 3.0,
        "bandwidth": 4.5,
        "segment_selection_method": "max",
        "n_jobs": -1,
    }
    assert captured["without_simple_filter"] is True


def test_filter_falls_back_to_run_when_selected_segment_api_is_unavailable(monkeypatch):
    captured = {}

    class FakeSifter:
        def __init__(self, **kwargs):
            captured["init"] = kwargs

        def run(self, data, without_simple_filter=False):
            captured["without_simple_filter"] = without_simple_filter
            return data.iloc[:, :1]

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
            "params": {
                "withoutSimpleFilter": True,
            },
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "selectedMetricKeys": ["raw:node:node_load15"],
        "selectedSeriesCount": 1,
        "totalSeriesCount": 1,
        "selectedMetricCount": 1,
        "totalMetricCount": 1,
    }
    assert captured["without_simple_filter"] is True


def test_filter_interpolates_missing_values_before_running_sifter(monkeypatch):
    captured = {}

    class FakeSifter:
        def __init__(self, **kwargs):
            pass

        def run_with_selected_segment(self, data, without_simple_filter=False):
            captured["data"] = data.copy()
            return data.iloc[:, :1], None

    monkeypatch.setattr("app.Sifter", FakeSifter)

    client = TestClient(app)
    response = client.post(
        "/v1/filter",
        json={
            "clusterId": "a100",
            "jobId": "10001",
            "timestamps": [1700000000000, 1700000060000, 1700000120000],
            "series": [
                {
                    "seriesId": "node:node_load15:instance=gpu-node001:9100",
                    "metricKey": "raw:node:node_load15",
                    "metricName": "node_load15",
                    "values": [1.0, None, 3.0],
                }
            ],
        },
    )

    assert response.status_code == 200
    assert captured["data"].isna().sum().sum() == 0
    assert captured["data"].iloc[:, 0].tolist() == [1.0, 2.0, 3.0]


def test_filter_rejects_invalid_enum_parameter():
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
            "params": {
                "searchMethod": "invalid",
                "costModel": "rbf",
            },
        },
    )

    assert response.status_code == 422

from typing import Any, Literal

import pandas as pd
from fastapi import FastAPI, HTTPException
from metricsifter.sifter import Sifter
from pydantic import BaseModel, ConfigDict, Field, field_validator


class SeriesInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    series_id: str = Field(alias="seriesId")
    metric_key: str = Field(alias="metricKey")
    metric_name: str = Field(alias="metricName")
    values: list[float | None]


class MetricSifterParams(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    search_method: Literal["pelt", "binseg", "bottomup"] = Field(default="pelt", alias="searchMethod")
    cost_model: Literal["l1", "l2", "normal", "rbf", "linear", "clinear", "rank", "mahalanobis", "ar"] = Field(
        default="l2", alias="costModel"
    )
    penalty: Literal["aic", "bic"] | float = "bic"
    penalty_adjust: float = Field(default=2.0, alias="penaltyAdjust")
    bandwidth: float = 2.5
    segment_selection_method: Literal["weighted_max", "max"] = Field(default="weighted_max", alias="segmentSelectionMethod")
    n_jobs: int = Field(default=1, alias="nJobs")
    without_simple_filter: bool = Field(default=False, alias="withoutSimpleFilter")

    @field_validator("penalty_adjust", "bandwidth")
    @classmethod
    def validate_positive_float(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be greater than 0")
        return value

    @field_validator("n_jobs")
    @classmethod
    def validate_n_jobs(cls, value: int) -> int:
        if value == 0:
            raise ValueError("must not be 0")
        return value


class FilterRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cluster_id: str = Field(alias="clusterId")
    job_id: str = Field(alias="jobId")
    timestamps: list[int]
    series: list[SeriesInput]
    params: MetricSifterParams | None = None


app = FastAPI()


def build_dataframe(payload: FilterRequest) -> pd.DataFrame:
    if not payload.timestamps or not payload.series:
        return pd.DataFrame()

    row_count = len(payload.timestamps)
    frame_data: dict[str, list[float | None]] = {}

    for series in payload.series:
        if len(series.values) != row_count:
            raise HTTPException(status_code=400, detail=f"series {series.series_id} length does not match timestamps")
        frame_data[series.series_id] = series.values

    return pd.DataFrame(frame_data)


def build_metric_key_map(series: list[SeriesInput]) -> dict[str, str]:
    return {item.series_id: item.metric_key for item in series}


def clamp_index(value: int, length: int) -> int:
    return max(0, min(value, length - 1))


def prepare_dataframe_for_sifter(dataframe: pd.DataFrame) -> pd.DataFrame:
    if dataframe.empty:
        return dataframe

    # MetricSifter 0.1.0 cannot handle NaN values when it derives AIC/BIC penalties.
    return dataframe.astype(float).interpolate(limit_direction="both").fillna(0.0)


def run_sifter(
    sifter: Any,
    dataframe: pd.DataFrame,
    without_simple_filter: bool,
) -> tuple[pd.DataFrame, Any | None]:
    if callable(getattr(sifter, "run_with_selected_segment", None)):
        return sifter.run_with_selected_segment(dataframe, without_simple_filter=without_simple_filter)
    if callable(getattr(sifter, "run", None)):
        return sifter.run(dataframe, without_simple_filter=without_simple_filter), None
    raise AttributeError("Sifter does not implement run_with_selected_segment or run")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/filter")
def filter_metrics(payload: FilterRequest) -> dict[str, Any]:
    dataframe = prepare_dataframe_for_sifter(build_dataframe(payload))
    total_series_count = len(payload.series)
    total_metric_count = len({series.metric_key for series in payload.series})

    if dataframe.empty:
        return {
            "selectedMetricKeys": [],
            "selectedSeriesCount": 0,
            "totalSeriesCount": total_series_count,
            "selectedMetricCount": 0,
            "totalMetricCount": total_metric_count,
        }

    params = payload.params or MetricSifterParams()
    filtered_data, selected_segment = run_sifter(
        Sifter(
            search_method=params.search_method,
            cost_model=params.cost_model,
            penalty=params.penalty,
            penalty_adjust=params.penalty_adjust,
            bandwidth=params.bandwidth,
            segment_selection_method=params.segment_selection_method,
            n_jobs=params.n_jobs,
        ),
        dataframe,
        without_simple_filter=params.without_simple_filter,
    )
    selected_series_ids = list(filtered_data.columns)
    metric_key_map = build_metric_key_map(payload.series)
    selected_metric_keys = sorted({metric_key_map[series_id] for series_id in selected_series_ids if series_id in metric_key_map})

    response: dict[str, Any] = {
        "selectedMetricKeys": selected_metric_keys,
        "selectedSeriesCount": len(selected_series_ids),
        "totalSeriesCount": total_series_count,
        "selectedMetricCount": len(selected_metric_keys),
        "totalMetricCount": total_metric_count,
    }

    if selected_segment is not None and payload.timestamps:
        start_index = clamp_index(int(selected_segment.start_time), len(payload.timestamps))
        end_index = clamp_index(int(selected_segment.end_time), len(payload.timestamps))
        response["selectedWindow"] = {
            "fromMs": payload.timestamps[start_index],
            "toMs": payload.timestamps[end_index],
        }

    return response

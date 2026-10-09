import React, { useCallback } from 'react';
import { buildBandPath, buildLinePath, CHART_VIEWBOX_WIDTH, scaleValue } from './chartScale';

export interface ChartSeries {
  id: string;
  x: number[];
  y: number[];
  color: string;
  width?: number;
  dashed?: boolean;
  opacity?: number;
  band?: { min: number[]; max: number[] };
}

export interface ChartMarker {
  x: number;
  kind: 'running' | 'abnormal-end';
}

interface Props {
  series: ChartSeries[];
  xDomain: [number, number];
  yDomain: [number, number];
  height: number;
  ariaLabel: string;
  cursorX?: number | null;
  cursorColor?: string;
  markers?: ChartMarker[];
  markerColor?: string;
  onCursorChange?: (x: number | null) => void;
  onClick?: (event: React.MouseEvent<SVGSVGElement>) => void;
}

export function CompareChart({
  series,
  xDomain,
  yDomain,
  height,
  ariaLabel,
  cursorX = null,
  cursorColor = 'currentColor',
  markers = [],
  markerColor = 'currentColor',
  onCursorChange,
  onClick,
}: Props) {
  const width = CHART_VIEWBOX_WIDTH;

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (!onCursorChange) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      onCursorChange(xDomain[0] + ratio * (xDomain[1] - xDomain[0]));
    },
    [onCursorChange, xDomain]
  );

  const cursorPx = cursorX === null ? null : scaleValue(cursorX, xDomain, [0, width]);

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      style={{ display: 'block', cursor: onClick ? 'pointer' : undefined }}
      onMouseMove={handleMove}
      onMouseLeave={() => onCursorChange?.(null)}
      onClick={onClick}
    >
      {series.map((s) =>
        s.band ? (
          <path
            key={`${s.id}-band`}
            data-testid={`band-${s.id}`}
            d={buildBandPath(s.x, s.band.min, s.band.max, xDomain, yDomain, width, height)}
            fill={s.color}
            fillOpacity={0.15 * (s.opacity ?? 1)}
            stroke="none"
          />
        ) : null
      )}
      {series.map((s) => (
        <path
          key={s.id}
          data-testid={`line-${s.id}`}
          d={buildLinePath(s.x, s.y, xDomain, yDomain, width, height)}
          fill="none"
          stroke={s.color}
          strokeWidth={s.width ?? 1.5}
          strokeDasharray={s.dashed ? '4 3' : undefined}
          strokeOpacity={s.opacity ?? 1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {markers.map((marker, i) => {
        const px = scaleValue(marker.x, xDomain, [0, width]);
        return marker.kind === 'running' ? (
          <line
            key={i}
            data-testid="marker-running"
            x1={px}
            x2={px}
            y1={0}
            y2={height}
            stroke={markerColor}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <path
            key={i}
            data-testid="marker-abnormal-end"
            d={`M${px - 8} 2 L${px} 12 M${px} 2 L${px - 8} 12`}
            stroke={markerColor}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {cursorPx !== null && (
        <line
          data-testid="cursor"
          x1={cursorPx}
          x2={cursorPx}
          y1={0}
          y2={height}
          stroke={cursorColor}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

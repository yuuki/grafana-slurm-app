import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Input, useStyles2 } from '@grafana/ui';
import { listJobMetadataOptions } from '../../api/slurmApi';
import { buildListJobMetadataOptionsParams, MetadataField, SearchFilters } from './model';

interface Props {
  field: MetadataField;
  filters: SearchFilters;
  value: string;
  placeholder: string;
  width: number;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    dropdown: css({
      position: 'absolute',
      top: 'calc(100% + 4px)',
      left: 0,
      right: 0,
      zIndex: 20,
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: 6,
      background: theme.colors.background.primary,
      boxShadow: theme.shadows.z3,
      maxHeight: 220,
      overflowY: 'auto' as const,
    }),
    option: css({
      display: 'block',
      width: '100%',
      padding: '8px 10px',
      border: 'none',
      background: 'transparent',
      textAlign: 'left' as const,
      cursor: 'pointer',
      color: theme.colors.text.primary,
    }),
    optionHighlighted: css({
      background: theme.colors.background.secondary,
    }),
    status: css({
      padding: '8px 10px',
      color: theme.colors.text.secondary,
      fontSize: 12,
    }),
  };
}

export function MetadataAutocompleteField({ field, filters, value, placeholder, width, onChange, onSelect }: Props) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const blurTimerRef = useRef<number>();
  const { account, clusterId, name, partition, state, user } = filters;

  const canLoadOptions = Boolean(isOpen && clusterId);
  const requestParams = useMemo(
    () =>
      buildListJobMetadataOptionsParams(
        {
          clusterId,
          account,
          name,
          partition,
          state,
          user,
        },
        field,
        value
      ),
    [account, clusterId, field, name, partition, state, user, value]
  );

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== undefined) {
        window.clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!canLoadOptions) {
      requestIdRef.current += 1;
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      listJobMetadataOptions(requestParams)
        .then((response) => {
          if (requestId !== requestIdRef.current) {
            return;
          }
          setOptions(response.values);
          setHighlightedIndex(0);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) {
            return;
          }
          setOptions([]);
          setHighlightedIndex(0);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setLoading(false);
          }
        });
    }, value ? 180 : 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [canLoadOptions, requestParams, value]);

  const visibleOptions = useMemo(() => (canLoadOptions ? options.slice(0, 50) : []), [canLoadOptions, options]);
  const isLoading = canLoadOptions && loading;

  const closeList = () => {
    setIsOpen(false);
    setHighlightedIndex(0);
  };

  const selectOption = (nextValue: string) => {
    closeList();
    onSelect(nextValue);
  };

  return (
    <div style={{ position: 'relative' }}>
      <Input
        width={width}
        value={value}
        placeholder={placeholder}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          blurTimerRef.current = window.setTimeout(() => {
            closeList();
          }, 100);
        }}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          if (blurTimerRef.current !== undefined) {
            window.clearTimeout(blurTimerRef.current);
          }
          setIsOpen(true);
          onChange(event.currentTarget.value);
        }}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (!isOpen || visibleOptions.length === 0) {
            if (event.key === 'Escape') {
              closeList();
            }
            return;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlightedIndex((current) => (current + 1) % visibleOptions.length);
            return;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlightedIndex((current) => (current - 1 + visibleOptions.length) % visibleOptions.length);
            return;
          }

          if (event.key === 'Enter') {
            event.preventDefault();
            selectOption(visibleOptions[highlightedIndex]);
            return;
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            closeList();
          }
        }}
        aria-expanded={isOpen}
        aria-autocomplete="list"
      />
      {isOpen && (
        <div role="listbox" className={styles.dropdown}>
          {isLoading && <div className={styles.status}>Loading suggestions...</div>}
          {!isLoading && visibleOptions.length === 0 && <div className={styles.status}>No matches</div>}
          {!isLoading &&
            visibleOptions.map((option, index) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                className={cx(styles.option, index === highlightedIndex && styles.optionHighlighted)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
              >
                {option}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

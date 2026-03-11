import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@grafana/ui';
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

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 20,
  border: '1px solid var(--border-medium, #d1d9e0)',
  borderRadius: 6,
  background: 'var(--background-primary, #ffffff)',
  boxShadow: '0 8px 24px rgba(16, 24, 40, 0.12)',
  maxHeight: 220,
  overflowY: 'auto',
};

const optionStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
};

const statusStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: 'var(--text-secondary, #6b7280)',
  fontSize: 12,
};

export function MetadataAutocompleteField({ field, filters, value, placeholder, width, onChange, onSelect }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const blurTimerRef = useRef<number>();

  const canLoadOptions = Boolean(isOpen && filters.clusterId);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== undefined) {
        window.clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!canLoadOptions) {
      setOptions([]);
      setLoading(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      listJobMetadataOptions(buildListJobMetadataOptionsParams(filters, field, value))
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
  }, [canLoadOptions, field, filters.account, filters.clusterId, filters.name, filters.partition, filters.state, filters.user, value]);

  const visibleOptions = useMemo(() => options.slice(0, 50), [options]);

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
        <div role="listbox" style={dropdownStyle}>
          {loading && <div style={statusStyle}>Loading suggestions...</div>}
          {!loading && visibleOptions.length === 0 && <div style={statusStyle}>No matches</div>}
          {!loading &&
            visibleOptions.map((option, index) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                style={{
                  ...optionStyle,
                  background: index === highlightedIndex ? 'var(--background-secondary, #f4f5f8)' : 'transparent',
                }}
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

import React from 'react';
import { AppRootProps } from '@grafana/data';
import { AppSceneRoot } from '../../scenes/appScene';

export function App(props: AppRootProps) {
  const { meta } = props;
  return <AppSceneRoot meta={meta} />;
}

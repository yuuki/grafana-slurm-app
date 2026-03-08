import React from 'react';
import { AppPlugin } from '@grafana/data';
import { App } from './components/App/App';
import { AppConfig } from './components/AppConfig/AppConfig';

export const plugin = new AppPlugin<{}>().setRootPage(App).addConfigPage({
  title: 'Configuration',
  icon: 'cog',
  body: AppConfig,
  id: 'configuration',
});

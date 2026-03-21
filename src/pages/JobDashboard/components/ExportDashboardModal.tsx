import { useEffect, useState } from 'react';
import { Button, Field, Modal, Select } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';
import { loadFolderOptions } from '../../../api/slurmApi';

interface ExportDashboardModalProps {
  isOpen: boolean;
  defaultFolderUid?: string;
  onConfirm: (folderUid?: string) => void;
  onDismiss: () => void;
  exporting: boolean;
}

const GENERAL_FALLBACK: SelectableValue<string> = { label: 'General', value: '' };

export function ExportDashboardModal({ isOpen, defaultFolderUid, onConfirm, onDismiss, exporting }: ExportDashboardModalProps) {
  const [folders, setFolders] = useState<Array<SelectableValue<string>>>([]);
  const [selectedFolder, setSelectedFolder] = useState<SelectableValue<string> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setLoading(true);
    loadFolderOptions()
      .then((options) => {
        setFolders(options);
        const defaultOption = defaultFolderUid
          ? options.find((o) => o.value === defaultFolderUid) ?? GENERAL_FALLBACK
          : GENERAL_FALLBACK;
        setSelectedFolder(defaultOption);
      })
      .catch(() => {
        setFolders([GENERAL_FALLBACK]);
        setSelectedFolder(GENERAL_FALLBACK);
      })
      .finally(() => setLoading(false));
  }, [isOpen, defaultFolderUid]);

  if (!isOpen) {
    return null;
  }

  return (
    <Modal title="Export Dashboard" isOpen={isOpen} onDismiss={onDismiss}>
      <Field label="Folder">
        <Select
          inputId="export-folder-select"
          options={folders}
          value={selectedFolder}
          onChange={setSelectedFolder}
          isLoading={loading}
          placeholder="Select folder..."
        />
      </Field>
      <Modal.ButtonRow>
        <Button variant="secondary" onClick={onDismiss} disabled={exporting}>
          Cancel
        </Button>
        <Button onClick={() => onConfirm(selectedFolder?.value || undefined)} disabled={exporting || loading}>
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}

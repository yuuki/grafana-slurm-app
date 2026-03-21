import { useEffect, useState } from 'react';
import { Button, Modal, Select } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';
import { GrafanaFolder, listGrafanaFolders } from '../../../api/slurmApi';

interface ExportDashboardModalProps {
  isOpen: boolean;
  defaultFolderUid?: string;
  onConfirm: (folderUid?: string) => void;
  onDismiss: () => void;
  exporting: boolean;
}

const GENERAL_FOLDER: SelectableValue<string> = { label: 'General', value: '' };

export function ExportDashboardModal({ isOpen, defaultFolderUid, onConfirm, onDismiss, exporting }: ExportDashboardModalProps) {
  const [folders, setFolders] = useState<Array<SelectableValue<string>>>([]);
  const [selectedFolder, setSelectedFolder] = useState<SelectableValue<string> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setLoading(true);
    listGrafanaFolders()
      .then((result: GrafanaFolder[]) => {
        const options = [
          GENERAL_FOLDER,
          ...result.map((f) => ({ label: f.title, value: f.uid })),
        ];
        setFolders(options);

        const defaultOption = defaultFolderUid
          ? options.find((o) => o.value === defaultFolderUid) ?? GENERAL_FOLDER
          : GENERAL_FOLDER;
        setSelectedFolder(defaultOption);
      })
      .catch(() => {
        setFolders([GENERAL_FOLDER]);
        setSelectedFolder(GENERAL_FOLDER);
      })
      .finally(() => setLoading(false));
  }, [isOpen, defaultFolderUid]);

  if (!isOpen) {
    return null;
  }

  return (
    <Modal title="Export Dashboard" isOpen={isOpen} onDismiss={onDismiss}>
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="export-folder-select" style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>
          Folder
        </label>
        <Select
          inputId="export-folder-select"
          options={folders}
          value={selectedFolder}
          onChange={setSelectedFolder}
          isLoading={loading}
          placeholder="Select folder..."
        />
      </div>
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

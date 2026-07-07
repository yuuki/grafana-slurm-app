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

export function ExportDashboardModal(props: ExportDashboardModalProps) {
  // Mounting this subcomponent only while `isOpen` is true ensures its state
  // (in particular the initial `loading` value) resets every time the modal
  // is reopened, without needing to set state synchronously inside an effect.
  if (!props.isOpen) {
    return null;
  }

  return <ExportDashboardModalContent {...props} />;
}

function ExportDashboardModalContent({ isOpen, defaultFolderUid, onConfirm, onDismiss, exporting }: ExportDashboardModalProps) {
  const [folders, setFolders] = useState<Array<SelectableValue<string>>>([]);
  const [selectedFolder, setSelectedFolder] = useState<SelectableValue<string> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Closing the modal unmounts this component, so suppress state updates
    // once the effect is cleaned up.
    let cancelled = false;
    loadFolderOptions()
      .then((options) => {
        if (cancelled) {
          return;
        }
        setFolders(options);
        const defaultOption = defaultFolderUid
          ? options.find((o) => o.value === defaultFolderUid) ?? GENERAL_FALLBACK
          : GENERAL_FALLBACK;
        setSelectedFolder(defaultOption);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setFolders([GENERAL_FALLBACK]);
        setSelectedFolder(GENERAL_FALLBACK);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [defaultFolderUid]);

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

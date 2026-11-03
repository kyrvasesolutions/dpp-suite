import { useState } from "react";
import {
  Button,
  Dialog,
  DropZone,
  FileTrigger,
  Heading,
  Modal,
  ModalOverlay,
  Text,
  isFileDropItem,
} from "react-aria-components";
import { importProject, type Project } from "../model/project";

interface ImportDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  current: Project;
  onImport: (project: Project, summary: string) => void;
}

const ACCEPT = ["application/json", ".json"];

export function ImportDialog({ isOpen, onOpenChange, current, onImport }: ImportDialogProps) {
  const [error, setError] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    const result = importProject(await file.text(), current);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onImport(result.project, result.summary);
    onOpenChange(false);
  };

  return (
    <ModalOverlay className="modal-overlay" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="modal">
        <Dialog className="dialog">
          {({ close }) => (
            <>
              <Heading slot="title">Upload data</Heading>
              <DropZone
                className="dropzone"
                getDropOperation={(types) => (types.has("application/json") || types.has("Files") ? "copy" : "cancel")}
                onDrop={async (e) => {
                  const item = e.items.find(isFileDropItem);
                  if (item) await read(await item.getFile());
                }}
              >
                <Text slot="label">Drop a JSON project file here</Text>
                <FileTrigger acceptedFileTypes={ACCEPT} onSelect={(files) => read(files?.[0])}>
                  <Button className="primary">Choose file</Button>
                </FileTrigger>
              </DropZone>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <p className="muted small">
                Same format as Export. Include <code>left</code>, <code>right</code> and/or <code>mappings</code>: a file
                with only <code>mappings</code> keeps the current trees.
              </p>
              <div className="dialog-actions">
                <Button className="ghost" onPress={close}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

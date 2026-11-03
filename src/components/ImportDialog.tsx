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
import { databaseFromFile, readProject } from "../db/database";
import { importProject, importSummary, type Project } from "../model/project";

interface ImportDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  current: Project;
  onImport: (project: Project, summary: string) => void;
}

const ACCEPT = ["application/json", ".json", ".sqlite", ".db", "application/vnd.sqlite3", "application/x-sqlite3"];

const isDatabaseFile = (file: File) => /\.(sqlite3?|db)$/i.test(file.name) || file.type.includes("sqlite");

export function ImportDialog({ isOpen, onOpenChange, current, onImport }: ImportDialogProps) {
  const [error, setError] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    if (isDatabaseFile(file)) {
      try {
        const db = await databaseFromFile(new Uint8Array(await file.arrayBuffer()));
        const project = readProject(db);
        db.close();
        setError(null);
        onImport(project, importSummary(project.left, project.right, project.mappings.length, 0));
        onOpenChange(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't read the database file.");
      }
      return;
    }
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
                getDropOperation={() => "copy"}
                onDrop={async (e) => {
                  const item = e.items.find(isFileDropItem);
                  if (item) await read(await item.getFile());
                }}
              >
                <Text slot="label">Drop a JSON project or SQLite database file here</Text>
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
                Same formats as Export. A <code>.sqlite</code> file replaces everything. A JSON file can include{" "}
                <code>left</code>, <code>right</code> and/or <code>mappings</code>; one with only <code>mappings</code>{" "}
                keeps the current trees.
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

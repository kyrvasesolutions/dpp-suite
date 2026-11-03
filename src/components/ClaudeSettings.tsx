import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Input, Label, Modal, ModalOverlay, Text, TextField } from "react-aria-components";
import { MODEL } from "../llm/suggest";

interface ClaudeSettingsProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
  remember: boolean;
  onSave: (key: string, remember: boolean) => void;
}

export function ClaudeSettings({ isOpen, onOpenChange, apiKey, remember, onSave }: ClaudeSettingsProps) {
  const [draft, setDraft] = useState(apiKey);
  const [keep, setKeep] = useState(remember);

  return (
    <ModalOverlay
      className="modal-overlay"
      isDismissable
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) {
          setDraft(apiKey);
          setKeep(remember);
        }
        onOpenChange(open);
      }}
    >
      <Modal className="modal">
        <Dialog className="dialog">
          {({ close }) => (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSave(draft.trim(), keep);
                close();
              }}
            >
              <Heading slot="title">Connect Claude</Heading>
              <p className="muted small">
                Mapping suggestions use your own Anthropic API key and model <code>{MODEL}</code>. Usage is billed to
                your Anthropic account.
              </p>
              <TextField className="field" value={draft} onChange={setDraft} type="password" autoComplete="off">
                <Label>Anthropic API key</Label>
                <Input placeholder="sk-ant-…" spellCheck={false} />
                <Text slot="description" className="muted small">
                  Kept in this browser only and sent only to api.anthropic.com. Avoid shared devices.
                </Text>
              </TextField>
              <Checkbox className="checkbox" isSelected={keep} onChange={setKeep}>
                <span className="box" aria-hidden="true" />
                Remember on this device (otherwise cleared when the tab closes)
              </Checkbox>
              <div className="dialog-actions">
                {apiKey && (
                  <Button
                    className="ghost danger"
                    onPress={() => {
                      onSave("", false);
                      close();
                    }}
                  >
                    Forget key
                  </Button>
                )}
                <Button className="ghost" onPress={close}>
                  Cancel
                </Button>
                <Button type="submit" className="primary" isDisabled={!draft.trim()}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

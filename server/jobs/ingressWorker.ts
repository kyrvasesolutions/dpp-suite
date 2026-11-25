/**
 * Worker entry of the ingress task (D8-10). Installs the same egress guard as the main thread (D8-05), then answers one task.
 * It never logs, and it answers with a fixed error class only: no message, stack or value leaves the worker.
 */
import { parentPort } from "node:worker_threads";
import egressAllowlist from "../../config/egress-allowlist.json";
import { allowlistHosts, installEgressGuard } from "../security/egressGuard";
import { runIngressTask, type IngressTask } from "./ingressTask";

installEgressGuard({ allowlist: allowlistHosts(egressAllowlist.connect), mode: "refuse" });

parentPort!.once("message", (task: IngressTask) => {
  runIngressTask(task).then(
    (result) => parentPort!.postMessage({ ok: true, result }),
    (e) => parentPort!.postMessage({ ok: false, errorClass: e instanceof Error ? e.name : "Error" }),
  );
});

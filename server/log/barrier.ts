/**
 * Exception barrier (D8-04, T08): uncaught exceptions and unhandled rejections are logged as
 * `{ event: "crash", error_class, code }` and nothing else. Never the message, the stack or any value.
 */
export type CrashWriter = (line: string) => void;

const SAFE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The fixed-key crash line. Class and code pass a strict pattern or are replaced by a constant. */
export function crashLine(error: unknown): string {
  let errorClass = "UnknownError";
  let code = "none";
  try {
    if (error !== null && typeof error === "object") {
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string" && SAFE_CLASS.test(name)) errorClass = name;
      const c = (error as { code?: unknown }).code;
      if (typeof c === "string" && SAFE_CODE.test(c)) code = c;
    }
  } catch {
    /* a hostile getter: keep the constants */
  }
  return JSON.stringify({ event: "crash", error_class: errorClass, code })
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface BarrierOptions {
  write?: CrashWriter;
  exit?: (code: number) => void;
}

/** Installs the process handlers and returns an uninstall function. */
export function installExceptionBarrier(options: BarrierOptions = {}): () => void {
  const write = options.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onUncaught = (error: unknown) => {
    write(crashLine(error));
    exit(1);
  };
  const onRejection = (reason: unknown) => {
    write(crashLine(reason));
    // an unhandled rejection is logged the same way; the process is not left running in an unknown state
    exit(1);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
}

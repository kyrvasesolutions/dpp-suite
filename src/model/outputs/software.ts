/** The software that made an output: the package version and the commit it was built from (never a date). */
export interface SoftwareInfo {
  name: string;
  version: string;
  commit: string;
}

export const softwareInfo = (): SoftwareInfo => ({
  name: "dpp-traceability",
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
  commit: typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "unknown",
});

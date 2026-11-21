declare module "virtual:contract-pack" {
  import type { PackSource } from "./model/profile";
  const pack: PackSource & { packDir: string };
  export default pack;
}

import { z } from "zod";

// The content security policy allows no eval (config/csp.ts). Without this, zod probes `new Function` on
// its first parse, which the browser reports as a policy violation even though zod catches it.
// Imported first in main.tsx, because modules can parse while they load, before main.tsx's own code runs.
z.config({ jitless: true });

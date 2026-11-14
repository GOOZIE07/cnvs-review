// Supabase Edge Function entry point for CNVS AI Music. See handler.ts.
import { handle } from "./handler.ts";

Deno.serve(req => handle(req));

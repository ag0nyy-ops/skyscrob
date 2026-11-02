import { realDeps, type Env } from './env';
import { handleRequest } from './http';
import { runScheduled } from './service';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env, realDeps);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, realDeps));
  },
} satisfies ExportedHandler<Env>;

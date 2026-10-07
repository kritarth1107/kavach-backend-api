import type { AdminConfig } from "../auth";
import type { RouteDef } from "../router";
import { teamRoutes } from "./team";

/** Every admin route. scripts/test-admin.ts checks each has a permission, an audit action and the reason rule. */
export function adminRoutes(cfg: AdminConfig): RouteDef[] {
    return [...teamRoutes(cfg)];
}

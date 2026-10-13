import type { AdminConfig } from "../auth";
import type { RouteDef } from "../router";
import { aiRoutes } from "./ai";
import { deliveryRoutes } from "./delivery";
import { flagRoutes } from "./flags";
import { infraRoutes } from "./infra";
import { opsRoutes } from "./ops";
import { peopleRoutes } from "./people";
import { qualityRoutes } from "./quality";
import { supportRoutes } from "./support";
import { teamRoutes } from "./team";
import { waitlistRoutes } from "./waitlist";

/** Every admin route. scripts/test-admin.ts checks each has a permission, an audit action and the reason rule. */
export function adminRoutes(cfg: AdminConfig): RouteDef[] {
    return [...teamRoutes(cfg), ...opsRoutes(), ...peopleRoutes(), ...aiRoutes(), ...flagRoutes(), ...supportRoutes(), ...infraRoutes(), ...waitlistRoutes(), ...deliveryRoutes(), ...qualityRoutes()];
}

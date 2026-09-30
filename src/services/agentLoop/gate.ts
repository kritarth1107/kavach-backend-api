import { isTestPhone } from "../smokeFixtures.service";

/**
 * The agent loop is the decider only for fake +9997 numbers, and only when
 * AGENT_LOOP=1. Real numbers stay on the phrase routes.
 */
export function agentLoopEnabled(phone: string | null | undefined): boolean {
    return process.env.AGENT_LOOP === "1" && isTestPhone(phone);
}

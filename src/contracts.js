/**
 * @typedef {{ type: 'user.message', sessionId: string, text: string }} AgentIngressEvent
 */

/**
 * @typedef {{ type: 'assistant.message', sessionId: string, text: string }} AgentEgressEvent
 */

/**
 * @typedef {{
 *   start: (onOutput: (event: AgentIngressEvent) => Promise<void> | void) => Promise<void>,
 *   stop: () => Promise<void>,
 *   input: (event: AgentEgressEvent) => Promise<void>,
 *   isBusy: () => Promise<boolean>
 * }} IMAdapter
 */

/**
 * @typedef {{
 *   start: (onOutput: (event: AgentEgressEvent) => Promise<void> | void) => Promise<void>,
 *   stop: () => Promise<void>,
 *   input: (event: AgentIngressEvent) => Promise<void>,
 *   isBusy: () => Promise<boolean>
 * }} AgentAdapter
 */

export {};

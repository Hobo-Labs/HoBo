/** @module Interface hobo:sdk/agent@0.1.0 **/
export function invoke(agentId: string, prompt: CommandMessage): CommandMessage;
export type CommandMessage = import('./hobo-sdk-types.js').CommandMessage;
export type SdkError = import('./hobo-sdk-types.js').SdkError;

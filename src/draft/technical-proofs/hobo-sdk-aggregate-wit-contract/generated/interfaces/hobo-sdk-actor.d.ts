/** @module Interface hobo:sdk/actor@0.1.0 **/
export function send(actorId: string, message: CommandMessage): string;
export function ask(actorId: string, message: CommandMessage): string;
export type CommandMessage = import('./hobo-sdk-types.js').CommandMessage;
export type SdkError = import('./hobo-sdk-types.js').SdkError;

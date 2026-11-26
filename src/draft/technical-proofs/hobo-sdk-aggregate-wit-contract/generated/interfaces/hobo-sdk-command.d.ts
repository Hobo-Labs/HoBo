/** @module Interface hobo:sdk/command@0.1.0 **/
export function dispatch(command: CommandMessage): string;
export type CommandMessage = import('./hobo-sdk-types.js').CommandMessage;
export type SdkError = import('./hobo-sdk-types.js').SdkError;

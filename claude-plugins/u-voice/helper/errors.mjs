export class VoiceError extends Error {}

export function safeError(error) {
  return error instanceof VoiceError && error.message
    ? error.message
    : "Voice bridge failed. Check the local helper and network connection.";
}

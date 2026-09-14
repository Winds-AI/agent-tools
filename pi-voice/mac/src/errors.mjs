export class VoiceError extends Error {}

export function safeError(error) {
  if (error instanceof VoiceError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Voice failed. Check connectivity and credentials.";
}

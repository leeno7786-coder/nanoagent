/**
 * True when an API error means the *prompt* exceeded the context window.
 * Do not match a bare "context length" mention — OpenRouter 400s often
 * advertise the model's window in the error body without the prompt being full.
 */
export function isContextOverflowError(text: string): boolean {
  if (!text) return false;
  return /context_length_exceeded|too many tokens|prompt[\s_-]*(?:is\s*)?too long|input[\s_-]*(?:is\s*)?too long|(?:context|prompt)[\s_-]*(?:length|window|size)[\s_-]*(?:exceeded|exceeds)|exceeded[\s_-]*(?:the\s+)?(?:maximum\s+)?(?:context|sequence)[\s_-]*(?:length|window)|maximum[\s_-]*(?:context|sequence)[\s_-]*length.{0,120}(?:exceeded|however|requested|resulted)/i.test(
    text
  );
}

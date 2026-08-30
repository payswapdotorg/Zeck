/** Shared provider-name patterns for the neutrality scanner. */

/** Provider-specific identifiers (types, functions, variables — not rail slugs). */
export const PROVIDER_IDENTIFIER =
  /\b(OpenRouter|Anthropic|OpenAI|Gemini|Groq|Mistral|Cohere|Azure|openRouter|anthropic|openAI|gemini|groq|mistral|cohere)\w*/;

/** Provider rail slugs as string literals. */
export const RAIL_LITERAL = /["'](openrouter|anthropic|gemini|groq|mistral|cohere)["']/;

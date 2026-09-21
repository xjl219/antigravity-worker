export interface Env {
  ACCOUNT_POOL: DurableObjectNamespace;
  ADMIN_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  GOOGLE_CODE_ASSIST_BASE_URL: string;
  GOOGLE_OAUTH_REDIRECT_PATH: string;
  PUBLIC_BASE_URL: string;
  DEFAULT_MODEL: string;\n  ANTHROPIC_USER_AGENT?: string;
}

export type AccountRow = {
  id: string; email: string; project_id: string | null;
  access_token_enc: string | null; refresh_token_enc: string | null;
  access_token_expires_at: number | null; status: "ACTIVE" | "BLOCKED";
  cooldown_until: number; health_score: number; failure_count: number;
  last_used_at: number; created_at: number; updated_at: number;
};

export type SessionRow = {
  session_id: string; account_id: string; created_at: number;
  last_used_at: number; expires_at: number;
};

export type InternalGenerateRequest = {
  requestId?: string;
  userAgent?: string;
  model: string; project?: string;
  request: {
    contents: Array<{role:"user"|"model";parts:Array<{text:string}>}>;
    systemInstruction?: {parts:Array<{text:string}>};
    generationConfig?: Record<string, unknown>;
    tools?: Array<Record<string, unknown>>;
    toolConfig?: Record<string, unknown>;
    tool_config?: Record<string, unknown>;
    safetySettings?: Array<Record<string, unknown>>;
  };
};

export type ChatRequest = {
  model?: string;
  messages: Array<{
    role: "system"|"user"|"assistant";
    content: string | Array<{type?:string;text?:string}>;
  }>;
  temperature?: number; top_p?: number; max_tokens?: number; stream?: boolean;
};

export type AnthropicMessage={role:"user"|"assistant";content:string|Array<{
  type:"text"|"image"|"tool_use"|"tool_result";text?:string;id?:string;name?:string;
  input?:Record<string,unknown>;tool_use_id?:string;content?:string|Array<{type:"text";text:string}>;
  source?:{type:"base64";media_type:string;data:string};
}>};
export type AnthropicRequest={
  model:string;messages:AnthropicMessage[];system?:string|Array<{type:"text";text:string}>;
  max_tokens:number;stream?:boolean;temperature?:number;top_p?:number;top_k?:number;stop_sequences?:string[];
  tools?:Array<{name:string;description?:string;input_schema?:Record<string,unknown>}>;
  tool_choice?:string|{type:string;name?:string};metadata?:Record<string,unknown>;
};

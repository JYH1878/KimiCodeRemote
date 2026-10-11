export interface SessionItem {
  id: string;
  title: string;
  updated_at: number;
  busy: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  last_prompt?: string;
}

export interface SessionsResponse {
  code: number;
  msg?: string;
  data?: { items?: SessionItem[] };
}

// ---- v2 sessions?view=by_workspace ----

export type ActivityStatus = 'running' | 'approval' | 'question' | 'failed' | 'idle';

export interface V2SessionMeta {
  title?: string;
  last_prompt?: string;
  created_at?: number;
  updated_at?: number;
  archived?: boolean;
}

export interface V2SessionItem {
  id: string;
  workspace?: { id?: string; cwd?: string | null };
  meta?: V2SessionMeta;
  activity?: { status?: ActivityStatus; model?: string };
}

export interface V2WorkspaceGroupData {
  workspace: { id?: string; cwd?: string | null };
  sessions: V2SessionItem[];
  total?: number;
}

export interface V2ByWorkspaceResponse {
  code?: number;
  msg?: string;
  data?: {
    groups?: V2WorkspaceGroupData[];
    has_more?: boolean;
    next_page_token?: string;
  };
}

// ---- messages ----

export type ContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; tool_call_id?: string; tool_name?: string; input?: unknown }
  | { type: 'tool_result'; tool_call_id?: string; output?: unknown; is_error?: boolean }
  | { type: 'image'; [k: string]: unknown }
  | { type: 'other' };

// ---- message origin metadata (desktop server v2.1.1, all fields optional) ----

export interface MessageOrigin {
  kind?: string; // 'user' | 'injection' | 'skill_activation' | 'task' | …
  variant?: string; // injection sub-kind: loadable-tools / date_change / interruption
  skillName?: string;
  skillArgs?: string;
  clientMetadata?: Array<{
    display_text?: string;
    kimi_code_composer?: { attachments?: Array<{ name?: string }> };
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: ContentBlock[];
  metadata?: { origin?: MessageOrigin; [k: string]: unknown };
  /** local optimistic echo, replaced once the server confirms the real message */
  local?: boolean;
}

export interface MessagesPageData {
  items?: Message[]; // newest -> oldest, as returned by the server
  has_more?: boolean;
}

export interface Approval {
  approval_id: string;
  tool_name: string;
  action: string;
  tool_input_display?: unknown;
  created_at?: string;
}

export interface InnerQuestion {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
}

export interface QuestionEntry {
  question_id: string;
  questions: InnerQuestion[];
}

export interface EnvelopeBody {
  status: number;
  body: { code?: number; msg?: string; data?: unknown } | null;
}

export interface SessionStatus {
  busy: boolean;
  model?: string;
  pending_interaction?: string;
  context_usage?: number;
}

/**
 * Gazebo Store — Zustand state management for Duckpond.
 *
 * This is the single source of truth for conversation state.
 * The store can be updated from anywhere (React components, SSE handlers, etc.)
 * without React's rules of hooks applying.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

// JSON types (assistant-ui compatible)
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

// Content part types (mutable for immer)
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; image: string };
export type ToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: JSONObject;
  argsText: string;
  result?: JSONValue;
  isError?: boolean;
};
export type ContentPart = TextPart | ImagePart | ToolCallPart;

// Our internal message format
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: ContentPart[];
  createdAt: Date;
}

// Attachment (for composer)
export interface Attachment {
  type: "image";
  image: string; // data URL
}

// -----------------------------------------------------------------------------
// Store Interface
// -----------------------------------------------------------------------------

interface GazeboState {
  // Core state
  sessionId: string | null;
  messages: Message[];
  isRunning: boolean;
  inputTokens: number | null;

  // Pagination readiness (vestigial for now)
  totalMessageCount: number;
  hasMoreHistory: boolean;
}

interface GazeboActions {
  // Message actions
  addUserMessage: (content: string, attachments?: Attachment[]) => string; // Returns message ID
  addAssistantPlaceholder: () => string; // Returns message ID
  appendToAssistant: (messageId: string, text: string) => void;
  addToolCall: (messageId: string, toolCall: Omit<ToolCallPart, "type">) => void;
  updateToolResult: (
    messageId: string,
    toolCallId: string,
    result: JSONValue,
    isError?: boolean
  ) => void;
  setMessages: (messages: readonly Message[] | Message[]) => void;

  // Session actions
  setSessionId: (sessionId: string | null) => void;
  setRunning: (running: boolean) => void;
  setInputTokens: (tokens: number | null) => void;

  // Bulk actions
  reset: () => void;
  loadSession: (sessionId: string, messages: Message[], totalCount?: number) => void;
}

export type GazeboStore = GazeboState & GazeboActions;

// -----------------------------------------------------------------------------
// ID Generation
// -----------------------------------------------------------------------------

let messageIdCounter = 0;
export const generateId = () => `msg-${Date.now()}-${++messageIdCounter}`;

// -----------------------------------------------------------------------------
// Initial State
// -----------------------------------------------------------------------------

const initialState: GazeboState = {
  sessionId: null,
  messages: [],
  isRunning: false,
  inputTokens: null,
  totalMessageCount: 0,
  hasMoreHistory: false,
};

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useGazeboStore = create<GazeboStore>()(
  immer((set) => ({
    ...initialState,

    // --- Message Actions ---

    addUserMessage: (content, attachments) => {
      const id = generateId();
      const parts: ContentPart[] = [];

      // Add images first (if any)
      if (attachments) {
        for (const att of attachments) {
          if (att.type === "image") {
            parts.push({ type: "image", image: att.image });
          }
        }
      }

      // Add text
      parts.push({ type: "text", text: content });

      set((state) => {
        state.messages.push({
          id,
          role: "user",
          content: parts,
          createdAt: new Date(),
        });
        state.totalMessageCount = state.messages.length;
      });

      return id;
    },

    addAssistantPlaceholder: () => {
      const id = generateId();
      set((state) => {
        state.messages.push({
          id,
          role: "assistant",
          content: [], // Empty, will be filled by stream
          createdAt: new Date(),
        });
        state.totalMessageCount = state.messages.length;
      });
      return id;
    },

    appendToAssistant: (messageId, text) => {
      set((state) => {
        const message = state.messages.find((m) => m.id === messageId);
        if (!message || message.role !== "assistant") return;

        // Find existing text part or create one
        const textPartIndex = message.content.findIndex((p) => p.type === "text");
        if (textPartIndex >= 0) {
          // Append to existing text
          const part = message.content[textPartIndex] as TextPart;
          message.content[textPartIndex] = {
            type: "text",
            text: part.text + text,
          };
        } else {
          // Insert text at beginning (before tool calls)
          message.content.unshift({ type: "text", text });
        }
      });
    },

    addToolCall: (messageId, toolCall) => {
      set((state) => {
        const message = state.messages.find((m) => m.id === messageId);
        if (!message || message.role !== "assistant") return;

        message.content.push({
          type: "tool-call",
          ...toolCall,
        });
      });
    },

    updateToolResult: (messageId, toolCallId, result, isError = false) => {
      set((state) => {
        const message = state.messages.find((m) => m.id === messageId);
        if (!message) return;

        const toolCall = message.content.find(
          (p): p is ToolCallPart =>
            p.type === "tool-call" && p.toolCallId === toolCallId
        );
        if (toolCall) {
          toolCall.result = result;
          toolCall.isError = isError;
        }
      });
    },

    setMessages: (messages) => {
      set((state) => {
        state.messages = [...messages]; // Copy to mutable array
        state.totalMessageCount = messages.length;
      });
    },

    // --- Session Actions ---

    setSessionId: (sessionId) => {
      set((state) => {
        state.sessionId = sessionId;
      });
    },

    setRunning: (running) => {
      set((state) => {
        state.isRunning = running;
      });
    },

    setInputTokens: (tokens) => {
      set((state) => {
        state.inputTokens = tokens;
      });
    },

    // --- Bulk Actions ---

    reset: () => {
      set(initialState);
    },

    loadSession: (sessionId, messages, totalCount) => {
      set((state) => {
        state.sessionId = sessionId;
        state.messages = messages;
        state.totalMessageCount = totalCount ?? messages.length;
        state.hasMoreHistory = totalCount ? totalCount > messages.length : false;
      });
    },
  }))
);

// -----------------------------------------------------------------------------
// Selectors (for convenience)
// -----------------------------------------------------------------------------

export const selectMessages = (state: GazeboStore) => state.messages;
export const selectSessionId = (state: GazeboStore) => state.sessionId;
export const selectIsRunning = (state: GazeboStore) => state.isRunning;
export const selectInputTokens = (state: GazeboStore) => state.inputTokens;

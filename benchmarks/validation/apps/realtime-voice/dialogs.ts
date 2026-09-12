/**
 * The realtime voice-loop session fixtures (VAL-014) with ground truths.
 *
 * Each session is a BOUNDED, DECLARED turn stream: the turn list is
 * pinned up front (the app's task payload carries the count; the driver
 * never invents turns), each turn is typed (`userClip` in → ASR leg,
 * `replyPhrase` out → TTS leg), and the interruption directive tells
 * the driver where the session's wait-user/resume boundary lands. The
 * ground truth pins the expected terminal, the exactly-once turn
 * accounting (no turn dispatched twice across interruptions), and the
 * fault-injection semantics for the corrupted-checkpoint edge (the
 * corpus's designed failure).
 *
 * This is a BOUNDED typed turn protocol — never an unbounded stream
 * claim: the session's turn count is declared before the first dispatch
 * and the driver's turn accounting refuses any turn beyond it.
 */

export interface VoiceLoopTurnDefinition {
  /** The user's inbound clip (audio-synthetic fixtures). */
  readonly clip: string;
  /** The platform's pinned reply phrase (TTS input). */
  readonly replyPhrase: string;
  /** The TTS voice for the reply. */
  readonly voice: string;
}

export interface VoiceSessionDefinition {
  readonly sessionId: string;
  readonly turns: readonly VoiceLoopTurnDefinition[];
  /** Where the session's interruption boundary lands. */
  readonly interrupt: "none" | "after-turn-1" | "stale-worker" | "corrupt-checkpoint";
  /** True when the scenario replays a no-op resume after terminal. */
  readonly resumeAfterTerminal?: boolean;
  readonly expectedTerminal: "COMPLETED" | "FAILED";
}

export const VOICE_SESSIONS: readonly VoiceSessionDefinition[] = [
  {
    sessionId: "dlg-001",
    turns: [
      { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
      { clip: "utt-001", replyPhrase: "phrase-003", voice: "Cherry" },
    ],
    interrupt: "none",
    expectedTerminal: "COMPLETED",
  },
  {
    sessionId: "dlg-002",
    turns: [
      { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
      { clip: "cmd-002", replyPhrase: "phrase-001", voice: "Cherry" },
    ],
    interrupt: "after-turn-1",
    expectedTerminal: "COMPLETED",
  },
  {
    sessionId: "dlg-003",
    turns: [
      { clip: "utt-001", replyPhrase: "phrase-003", voice: "Cherry" },
      { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
    ],
    interrupt: "stale-worker",
    expectedTerminal: "COMPLETED",
  },
  {
    sessionId: "dlg-004",
    turns: [{ clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" }],
    interrupt: "none",
    resumeAfterTerminal: true,
    expectedTerminal: "COMPLETED",
  },
  {
    sessionId: "dlg-005",
    turns: [
      { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
      { clip: "cmd-002", replyPhrase: "phrase-001", voice: "Cherry" },
    ],
    interrupt: "corrupt-checkpoint",
    expectedTerminal: "FAILED",
  },
];

/** The app's pinned task payloads (the public-API task shapes). */
export const REALTIME_VOICE_TASKS = VOICE_SESSIONS.map((session) => ({
  kind: "voice-loop" as const,
  session: session.sessionId,
  ...(session.resumeAfterTerminal === true
    ? { resume: "after-terminal" as const }
    : { interrupt: session.interrupt }),
})) as readonly {
  kind: "voice-loop";
  session: string;
  interrupt?: string;
  resume?: string;
}[];

/** Per-session expected terminal (the corpus rows' own expectations). */
export function expectedTerminalForSession(sessionId: string): "COMPLETED" | "FAILED" {
  const session = VOICE_SESSIONS.find((candidate) => candidate.sessionId === sessionId);
  return session?.expectedTerminal ?? "COMPLETED";
}

/** The deterministic turn leg effects (the exactly-once journal entries). */
export function turnLegEffect(sessionId: string, turn: number, leg: "asr" | "tts"): string {
  return `${sessionId}:turn-${turn}:${leg}`;
}

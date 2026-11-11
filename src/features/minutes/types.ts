export type TitleSource = "user" | "generated";
export type MeetingStatus = "draft" | "reviewed" | "archived";
export type FollowupStatus = "open" | "done";

export interface DecisionItem {
  id: string;
  text: string;
  quote: string | null;
  timestamp: string | null;
}

export interface FollowupItem {
  id: string;
  task: string;
  owner: string | null;
  due: string | null;
  status: FollowupStatus;
}

export interface MeetingProfile {
  schema: 1;
  title: string;
  title_source: TitleSource;
  held_at: string | null;
  duration_seconds: number | null;
  status: MeetingStatus;
  participants: string[];
  participants_text: string;
  tags: string[];
  summary: string;
  decisions: DecisionItem[];
  followups: FollowupItem[];
  transcript: string;
  synthetic: boolean;
}

export interface JournalEntry {
  revision: number;
  operation: "create" | "update";
  actor: string;
  at: number;
  digest: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  provenance: Record<string, unknown> | null;
}

export interface MeetingRecord {
  id: string;
  installId: string;
  contextId: string;
  revision: number;
  digest: string;
  profile: MeetingProfile;
  history: JournalEntry[];
  historyTruncated: boolean;
}

export interface MeetingListResult {
  records: MeetingRecord[];
  total: number;
  truncated: boolean;
  nextCursor: string | null;
}

export interface TranscriptLine {
  timestamp: string | null;
  speaker: string | null;
  text: string;
}
